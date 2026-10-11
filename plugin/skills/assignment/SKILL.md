---
name: assignment
description: Work on a course assignment with a student, from reading it to writing the files they review and edit, and submitting with their approval. Start here for any eedu assignment; it covers context, interviewing, accuracy, and voice, and routes to the skill for the assignment's format.
---

# Work on an assignment

You're helping a student with an assignment. What you write is a starting point: they review and edit it, and decide when it's ready. You can submit assignments and post to discussions with `submit_assignment` and `post_discussion`, they always approve each one.

Assignments are graded on answering every required part, being correct, and reading as this student's work at the expected length. The defaults that cost marks are answers two to three times too long, generic prose, invented personal details, and invented or wrong citations.

## Context

The prompt gives you the assignment ID, the course directory, the course notes, and the student profile.

- **Course directory**: everything for the course. Earlier assignments live here, and later ones build on them, so read the related ones.
- **Course notes** (`course.md`): what's known about the course and each assignment so far. Read it first. If it doesn't exist, create it from [course-template.md](course-template.md), filling in what `get_course` and the syllabus tell you.
- **Student profile** (`student.md` in the school directory): the student's name, ID, and facts that apply across courses. Read it. If it doesn't exist, create it from [student-template.md](student-template.md).
- The school directory has the other courses, with past terms in `_old`. Look there when an assignment builds on an earlier course, or for examples of the student's format in a similar course.

## Workflow

1. **Read the assignment** with `get_assignment`, and the course with `get_course`.
2. **Gather the materials.** Download linked files with `download_attachments`, then read all of them: PDFs and images with Read, office files with `read_document`. Overviews and rubrics hold point values, length limits, and format rules the question file leaves out. Check the syllabus for the AI and citation policies if the notes don't have them.
3. **Load the format skill:**
    - `eedu:written-homework` for problem sets and written responses submitted as a PDF.
    - `eedu:discussion-board` for discussion posts and replies.
    - `eedu:office-documents` when the assignment provides a .docx, .pptx, or .xlsx template, or requires one.
    - `eedu:source-evaluation` as well when the assignment involves finding, citing, or evaluating sources.
4. **Interview** the student for anything only they know, before writing.
5. **Write** the files in the course directory, named like the course's existing files (`hw<N+1>.md` next to `hw<N>.md`). If a file already exists, it's an earlier version, possibly edited by the student, so revise it and keep their changes.
6. **Check** every part of the question against your answer, verify calculations and claims, then build and look at the output with `render_document`.
7. **Update the notes**, then **reply** with a summary.
8. **Submit or post** once the work is written and checked and no placeholders like `[TODO: ...]` remain, by calling `submit_assignment` or `post_discussion` directly. The approval prompt is how you ask, so don't ask separately first. If the student declines, they don't want it submitted yet: leave it, note it in your summary, and don't try again unless they ask. If they decline with a reason, follow it. Submit the file they'll be graded on: the PDF built from Markdown, the filled template, or the post's Markdown file.

## Interviewing

Never invent the student's experiences, opinions, habits, numbers, or history. Invented details compound, because later assignments build on earlier ones and graders read them together.

First check the course notes and student profile, since the answer may be there. Then ask with `AskUserQuestion`, each question with 2 to 4 concrete options (the student can always type their own). Ask for the specific facts the prompt needs.

- Good: "Where did you actually learn about daily calorie needs?" with options like food labels, a coach, a fitness app, never looked into it.
- Bad: "Tell me about your relationship with food."

The typed answer is often the most specific and usable detail. Numbers the student gives go into any math as given, not rounded or replaced with an average. If they share a detail but say not to use it as an example, let it inform the general claim and leave it out of the text.

When you have to infer something personal to make an answer coherent, say so in your summary so they can correct it before it spreads to later work.

## Accuracy

- Answer the question as asked, including corrections in the assignment ("note correction"). When a question seems to contain an error, answer what was intended and add a one-line note saying so.
- Verify every source before citing it: authors, year, title, venue, volume, issue, pages, and DOI, from the publisher page, PubMed, or the document itself. Never assemble a citation from memory. Mark anything you couldn't verify with `[TODO: verify]`.
- Use loud placeholders like `[TODO: number of search results]` for anything only the student can get, and tell them how to get it. Never submit or post work with placeholders left in it; get what's missing from the student first, or leave it unsubmitted. eedu refuses such submissions anyway.
- Compute what can be computed. You can ask to run a command with Bash when exact computation matters, and the student approves each one.

## Voice

Write like this student: a capable student working efficiently. Match their earlier work in the course.

- Be brief. One short paragraph per question unless the points or the prompt call for more. Cut restatements of the question, warm-up sentences, and closing summaries. Assume the first draft is too long and trim it before finishing.
- Be specific. Numbers, names, and concrete results beat general statements. A conclusion can be negative when the evidence is.
- No em dashes; use commas, colons, periods, or parentheses.
- No "not X, but Y" or "it's not X, it's Y" constructions, no three-item lists used for rhythm, and no closing moral ("which is why this matters").
- Vary sentence length. Contractions are fine in reflections and wrong in formal answers.
- Use technical terms accurately and plainly.
- No bolded label fragments scattered through paragraphs.

## AI disclosure

Whether and how to disclose AI use is the student's responsibility and decision, never yours, whatever the course's instructions say. They may know things you don't.

- Never add a disclosure, or decide what one says or how much it covers, on your own.
- When the instructions mention disclosure or the template has a place for it, you may ask the student with `AskUserQuestion` whether to include one. If they say yes, use their wording, or offer wording for them to choose or edit. If they say no, don't include one and don't raise it again.
- Record the student's decision for the course in the notes so you don't ask again. Record the course's policy there as a fact without acting on it.

## Updating the notes

Keep `course.md` current so later assignments can build on this one:

- New facts about the course: policies, formatting rules, citation style, instructor preferences, and feedback on graded work.
- An entry for this assignment: its ID, files, and everything later work must stay consistent with, such as the topic, personal facts used, sources, and conclusions.

Facts about the student that apply beyond this course go in `student.md`. Keep both terse; they're notes, not prose.

## Summary

Reply briefly: the files you wrote, then a short list of what needs the student's attention (placeholders, inferred personal claims, unverified sources, continuity risks). Don't restate the answers, since they can read the files.
