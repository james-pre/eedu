---
name: office-documents
description: Fill in .docx, .pptx, and .xlsx assignment templates in place, or create new office files, preserving the instructor's formatting. Use when an assignment provides a template with answer boxes or requires a Word, PowerPoint, or Excel file.
---

# Office documents

## Reading

Read templates with `read_document`, which gives Markdown for .docx (tables become grid tables), CSV for each sheet of a spreadsheet, and text for slides. Look at the layout with `render_document`.

A `.~lock.<name>#` file next to a document means the student has it open in LibreOffice. Ask them to close it before you write to it.

## Filling in a template

The output is the student's own template with the answers filled in, not a new document. Edit the XML in place so the instructor's formatting survives:

1. `unpack_office` the template. It extracts to `.<name>.parts/` next to the file and lists the XML parts. A Word document's body is `word/document.xml`.
2. Find the answer locations with Read and Grep. In question and answer tables, question rows have text and answer rows are empty cells (`<w:tc>` with an empty `<w:p>`), usually alternating.
3. Fill each answer with Edit, replacing the empty paragraph in the cell with your paragraphs. Copy the `<w:pPr>` and `<w:rPr>` from a nearby paragraph in the same cell or table so fonts and spacing match.
4. `pack_office` the folder back into the template's path. The original is kept as `.<name>.orig<ext>` the first time.
5. `render_document` the result and look at every page.

XML details:

- Escape `&`, `<`, and `>` in text, and use `<w:t xml:space="preserve">` so leading and trailing spaces survive.
- `<w:pPr>` children have a fixed order: `w:ind` comes before `w:jc`. The wrong order makes Word reject the file.
- Templates often have no bullet numbering defined. For a bulleted list, a literal `•` and a tab with `<w:ind w:left="720" w:hanging="360"/>` renders correctly and is lower risk than adding numbering definitions.
- Word splits text into many runs, so search for short distinctive fragments rather than whole sentences.
- Don't touch anything outside the answer areas: headers, instructions, fields, and section properties stay as they are.
- LibreOffice sometimes renders a table row that splits across a page in a fallback font even though the XML is correct. Check the XML before chasing it.

Spreadsheets (`xl/worksheets/sheet<N>.xml` with shared strings in `xl/sharedStrings.xml`) and slides (`ppt/slides/slide<N>.xml`) follow the same approach: fill existing cells and text boxes, and keep the structure.

## Creating a new file

- **Word or PowerPoint:** write Markdown, then `convert_document` it to .docx or .pptx. For slides, each `##` heading starts a slide and `#` headings start sections; keep slides to a few bullets and put talking points in a `::: notes` block.
- **Excel:** write a CSV, then `convert_document` it to .xlsx. For formulas, write them in the cells (`=SUM(<range>)`).
- **PDF from an office file:** `convert_document` to .pdf, when the course wants a PDF.

Render every new file and check it before finishing.
