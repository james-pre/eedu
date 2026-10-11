---
name: discussion-board
description: Write discussion board posts and replies to classmates for a student to review and edit, then post them with the student's approval. Use for discussion assignments, reflection posts, and short-answer prompts with numbered sub-prompts ("respond to both", "pick two", "support with APA 7 sources").
---

# Discussion boards

Discussion prompts look like short essays but aren't. They're graded on hitting every required part, sounding like a specific person, and staying brief.

## Reading the board

A discussion assignment is linked to its board, so work with the board directly: read it with `read_discussion` and post with `post_discussion`, both using the assignment ID. Group discussions resolve to the student's group automatically. Never use `submit_assignment` for a discussion.

Read the prompt with `read_discussion`, along with the assignment's description and any rubric. Some boards require posting before showing other entries, so you may only see the prompt. Earlier boards in the course show the student's past posts and what the instructor responds to; the course notes list them.

## The initial post

Write the post to its own Markdown file in the course directory, named like earlier ones (`discussions/week-<N>.md`). The file holds only the post, because it's posted as is: by you with `post_discussion`, which the student approves, or by them with `eedu assignments submit <id> -T <file>`. The Markdown is converted when posted.

- Use the prompt's own numbering so the parts map one to one. A numbered prompt with four lettered sub-parts is still one answer: give each sub-part a sentence in a tight list.
- One short paragraph per prompt, about 4 to 6 sentences.
- Cut restatements of the prompt, transitions, and closing sentences that repeat the paragraph.
- One honest, slightly informal aside per post tied to something the student said makes it read as theirs. More than one is too many.
- No headings except a final **References** section when there are sources.

## Calculations

When the prompt asks for calculations, show the setup, substitution, and result on one line, and name the source of any coefficient:

`The RDA is <rate> g/kg/day, so at <weight> kg that's <rate> x <weight> = <result> g/day (source).`

Use the student's own numbers. When a second standard applies to them (an athlete, pregnancy, illness), give that range in the same sentence.

## Sources

When the prompt asks for credible sources:

- Cite 2 or 3. More looks wrong on a 150-word paragraph.
- Prefer well-known literature and official guidance from government agencies, major professional organizations, and landmark trials, and verify each one with web search.
- In-text citations in the body; full APA 7 references under **References**.
- Skip citations on personal reflection prompts that don't ask for them.

## Replies to classmates

When the assignment requires replies and their posts are visible, ask the student which posts to reply to (offer a few with a one-line summary each). Write each reply to its own file (`discussions/week-<N>-reply-<name>.md`) and note the entry ID. Post it with `post_discussion` (`reply_to`), or they can post it with `eedu discussions post <topic> -r <entry ID> -T <file>`.

A reply engages with something specific in the classmate's post: agree and extend with a fact or experience, or respectfully raise a different angle. Two to four sentences. Don't copy or closely paraphrase other students' posts.
