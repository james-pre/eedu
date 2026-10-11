---
name: written-homework
description: Write homework, problem sets, and written responses as Markdown that pandoc builds into the PDF the student submits, in the student's established format. Use for math, computer science, and other assignments turned in as a PDF.
---

# Written homework

Answers are Markdown files built into PDFs with `build_pdf` (pandoc with xelatex, `$` math, and raw TeX). The PDF is what gets submitted, so it has to look right. The questions usually come as a PDF from the instructor, and the answer file sits next to it (`hw<N>.md` next to the instructor's question PDF).

## Layout

Match the course's earlier files. Without any, use this:

```markdown
---
geometry: margin=3em
---

# <Course> Homework <N>

_<Name>_ \cdotp <Student ID>

## <N>.

## <N>. (a)

## <N>. (b)
```

- The title names the course and section the way the instructor does, then the assignment ("<Course> Homework <N>, Part <N>").
- Name and ID come from the student profile.
- One `##` heading per problem, numbered like the assignment: `## <N>.`, `## <N>. (a)` for parts. Follow the assignment's own structure when it has one (`## Part <N>.<M> <Topic>` then `### Question <N>.<M>.<K>`).
- Don't restate the question. A short expression can identify the problem in the heading (`## <N>. $(\lambda x.x)\ y$`).
- Put `\pagebreak` before a long problem that would split awkwardly.
- Add LaTeX packages in `header-includes` (TikZ for trees, diagrams, and graphs).
- Prose assignments, like design exercises or reflections, use the same front matter with `##` per question and no title when the course's earlier files have none.

## Math

- Show the work as a sequence of short display blocks, each `$$` on its own line, one step or idea per block.
- Use `\begin{aligned}` for multi-line derivations, aligned on `=` or the relation.
- Keep prose minimal; the equations carry the argument. `\implies`, `\checkmark`, `\qquad` separators, and short `\text{...}` notes are enough.
- Box every final answer: `\boxed{\;y = \dots\;}`, with units and conditions (`a \le t \le b`).
- Use the method the question names ("use the reduction of order formula", "use Newton's law of cooling") and the course's notation.
- Give exact forms, plus a decimal when the question asks for a number (`T(t_1) \approx \dots^\circ\text{F}`).
- Verify every answer by substitution, differentiation, or a second method before writing it. Write verification steps into the answer only when the question asks ("verify that...").

## Computing and technical courses

- Short, direct prose for explanations, with tables for data and intermediate values, `backticks` for literal values, and fenced code blocks for long bit strings and output.
- Use ` ```{.numberLines} ` for pseudocode and programs.
- Show work the way the question asks: numbered reasoning steps, tables of intermediate values, worked examples you computed yourself.
- Compute results exactly. When the work is long or error-prone (cipher rounds, bit permutations, simulations), ask to run a short script with Bash rather than working it by hand.
- When the question contains an error, answer the intended question and add a short note explaining the discrepancy.

## Building

After writing, build with `build_pdf` and look at the pages with `render_document`. Fix LaTeX errors, equations or tables running off the page, and awkward breaks before finishing.
