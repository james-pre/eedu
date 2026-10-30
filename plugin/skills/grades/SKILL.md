---
name: grades
description: Check and complete a course's grade setup in eedu from its syllabus and LMS, filling in missing weights, dropped and expected counts, and grades the LMS doesn't have. Use when asked to set up, fix, or check a course's grades.
---

# Grade setup

eedu predicts the student's course grade from categories (each with a weight, a mode, dropped and expected counts) holding grades. Grades are pulled from the LMS before you start. Your job is to make the setup match how the course is actually graded.

Change grades only with the grade tools (`set_category`, `move_grades`, `ignore_grades`, `add_grade`, `remove_grade`, `remove_category`, `set_passing`), never by editing eedu's files. Each takes a short reason, which the student sees, so cite where the fact came from.

## Sources

- **The LMS** is authoritative for which assignments exist, their scores, points possible, and the categories (assignment groups) they're in. Weights and drop rules it reports are usually right, but courses sometimes leave them unset or set them wrong.
- **The syllabus** is authoritative for the grading policy: category weights, drops, how many of each assignment, and the grading scale. Read it with `read_syllabus`, then read any downloaded files with Read or `read_document`. Course notes may already record the policy.
- **The student**, through `AskUserQuestion`, for anything the sources don't settle.

Never invent a weight, count, or score. When the sources disagree or say nothing, ask the student, or leave it unknown and say so in your summary.

## Workflow

1. Read the course notes, then `get_grades` and `get_course`.
2. Find the grading policy in the syllabus. If there's no syllabus in the LMS, look in the course directory, then ask the student.
3. **Map syllabus categories to eedu's.** When the LMS groups match, keep their names. When they don't (everything in one "Assignments" group, or a syllabus category split across groups), create the syllabus' categories with `set_category`, move the grades into them with `move_grades`, and remove empty LMS categories that don't count.
4. **Weights.** Fill in every unknown weight. Correct an LMS weight only when the syllabus clearly says otherwise. When the course grades by total points rather than weighted categories, give each category its share of the total points. Weights should add up to 100%; note extra credit that makes them add up to more.
5. **Drops and modes.** Set dropped counts from the syllabus ("lowest two quizzes dropped"). Use `average` when every assignment in a category counts equally regardless of points, and `points` otherwise.
6. **Expected counts.** When the syllabus says how many assignments a category has and the LMS hasn't posted them all, set `expected` to the total, including the ones posted.
7. **Grades outside the LMS.** Add graded work the LMS will never have (paper exams, attendance kept elsewhere) with `add_grade`, using `null` for scores not known yet. Don't add what the LMS will post later; that's what `expected` is for.
8. **Grades that don't count.** Ignore practice, ungraded, or duplicate items that the LMS includes but the syllabus doesn't count. Extra credit stays counted.
9. Set the passing grade from the grading scale with `set_passing` when it's clear, such as the lowest D or the minimum the syllabus names.
10. Record the grading policy in the course notes, creating them if needed, so later work can use it.

## Summary

Reply briefly: what you changed and why, and what's still unknown or uncertain, so the student can check it with `eedu grades show -l`.
