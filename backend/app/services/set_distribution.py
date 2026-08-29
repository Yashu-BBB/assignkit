"""
Student <-> set distribution (spec section 8):
 - Randomize student order first.
 - Distribute sets approximately evenly.
 - Never a predictable assignment order.
 - Question order independently shuffled per student, even within the same set.
"""
import random


def distribute_students_to_sets(student_ids: list[str], num_sets: int) -> dict[str, int]:
    """
    Returns {student_id: set_index (1-based)}.
    Shuffles student order, then round-robins across sets so counts are as
    even as possible; any remainder is assigned randomly (per spec's
    "61 students / 10 sets -> final student randomly receives any set" example).
    """
    shuffled = student_ids[:]
    random.shuffle(shuffled)

    n = len(shuffled)
    base_count = n // num_sets
    remainder = n % num_sets

    assignment: dict[str, int] = {}
    idx = 0
    for set_idx in range(1, num_sets + 1):
        for _ in range(base_count):
            assignment[shuffled[idx]] = set_idx
            idx += 1

    # Remaining students (the "leftover" from uneven division) get a random set each.
    remaining_students = shuffled[idx:]
    for student_id in remaining_students:
        assignment[student_id] = random.randint(1, num_sets)

    return assignment


def shuffle_question_order(question_ids: list[str]) -> list[str]:
    """Independent per-student shuffle — two students on the same set can see different order."""
    order = question_ids[:]
    random.shuffle(order)
    return order
