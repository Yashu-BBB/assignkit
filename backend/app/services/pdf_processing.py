"""
PDF processing pipeline (spec section 7):
  upload -> readability check -> text extraction OR OCR -> compact
  structured knowledge representation -> store.

The original PDF stays in Supabase Storage; only the compact
`extracted_knowledge` rows are re-used for AI generation, so we never
resend the full PDF to the model on every request.
"""
import logging

import fitz  # PyMuPDF
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import PDFUnreadableError
from app.services import ai_generation, storage_client
from app.utils.db_helpers import execute, fetch_one

logger = logging.getLogger("app.pdf")
settings = get_settings()


def _readability_score(doc: "fitz.Document") -> float:
    """Rough heuristic: fraction of pages with a usable amount of extractable text."""
    if doc.page_count == 0:
        return 0.0
    readable_pages = 0
    for page in doc:
        text = page.get_text().strip()
        if len(text) > 40:
            readable_pages += 1
    return readable_pages / doc.page_count


async def ingest_pdf(db: AsyncSession, subject_id: str, lecturer_id: str,
                      filename: str, content: bytes) -> dict:
    if len(content) > settings.MAX_PDF_SIZE_MB * 1024 * 1024:
        raise PDFUnreadableError(f"PDF exceeds the {settings.MAX_PDF_SIZE_MB}MB limit.")

    storage_path = storage_client.upload_pdf(subject_id, filename, content)
    doc_row = await fetch_one(
        db,
        """insert into source_documents (subject_id, uploaded_by, storage_path, original_filename, status)
           values (:sub, :lec, :path, :fname, 'processing')
           returning id, subject_id, storage_path, original_filename, status""",
        {"sub": subject_id, "lec": lecturer_id, "path": storage_path, "fname": filename},
    )
    doc_id = doc_row["id"]

    try:
        pdf_doc = fitz.open(stream=content, filetype="pdf")
    except Exception as e:
        logger.error("pdf_open_failed", extra={"doc_id": doc_id, "error": str(e)})
        await execute(db, "update source_documents set status = 'failed' where id = :id", {"id": doc_id})
        raise PDFUnreadableError("The uploaded file could not be read as a PDF.")

    score = _readability_score(pdf_doc)
    page_count = pdf_doc.page_count

    if score >= 0.7:
        # Normal text PDF — extract directly.
        raw_text = "\n".join(page.get_text() for page in pdf_doc)
        method = "text_extraction"
    else:
        # Low native-text yield — attempt OCR.
        raw_text, ocr_score = _run_ocr(pdf_doc)
        score = max(score, ocr_score)
        method = "ocr"

    if score < settings.MIN_OCR_QUALITY_SCORE:
        await execute(
            db,
            """update source_documents set status = 'low_quality', page_count = :pc,
                   quality_notes = :notes, processed_at = now() where id = :id""",
            {"pc": page_count, "notes": f"Readability score {score:.2f} below threshold "
                                         f"{settings.MIN_OCR_QUALITY_SCORE}. Extraction method: {method}.",
             "id": doc_id},
        )
        await db.commit()
        raise PDFUnreadableError(
            "This PDF's text quality is too low to generate reliable questions. "
            "Please upload a clearer scan or a text-based PDF."
        )

    await execute(
        db,
        """update source_documents set status = 'ready', page_count = :pc,
               quality_notes = :notes, processed_at = now() where id = :id""",
        {"pc": page_count, "notes": f"method={method}, score={score:.2f}", "id": doc_id},
    )

    # Build the compact knowledge representation via the AI provider, once,
    # and store it — this is what generation reads from thereafter.
    knowledge_items = await ai_generation.extract_knowledge(raw_text)
    for item in knowledge_items:
        await execute(
            db,
            """insert into extracted_knowledge
                 (source_document_id, topic, concept, definition, examples, key_terms, code_patterns, raw_excerpt)
               values (:doc, :topic, :concept, :definition, :examples, :terms, :patterns, :excerpt)""",
            {
                "doc": doc_id, "topic": item.get("topic", ""), "concept": item.get("concept"),
                "definition": item.get("definition"), "examples": item.get("examples", []),
                "terms": item.get("key_terms", []), "patterns": item.get("code_patterns", []),
                "excerpt": item.get("raw_excerpt", "")[:1000],
            },
        )

    logger.info("pdf_processed", extra={"doc_id": doc_id, "method": method, "score": round(score, 2),
                                         "knowledge_items": len(knowledge_items)})
    return {"id": doc_id, "status": "ready", "page_count": page_count,
            "knowledge_items": len(knowledge_items)}


def _run_ocr(pdf_doc: "fitz.Document") -> tuple[str, float]:
    """
    OCR fallback for scanned/image PDFs using pytesseract on rasterized pages.
    Returns (extracted_text, avg_confidence_0_to_1).
    """
    import pytesseract
    from PIL import Image
    import io

    texts, confidences = [], []
    for page in pdf_doc:
        pix = page.get_pixmap(dpi=200)
        img = Image.open(io.BytesIO(pix.tobytes("png")))
        data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
        page_text = " ".join(w for w in data["text"] if w.strip())
        texts.append(page_text)
        confs = [int(c) for c in data["conf"] if c not in ("-1", -1)]
        if confs:
            confidences.append(sum(confs) / len(confs) / 100)

    avg_conf = sum(confidences) / len(confidences) if confidences else 0.0
    return "\n".join(texts), avg_conf
