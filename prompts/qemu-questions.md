Read the image at {{image}}. It is a screenshot of a study-question page.

For every question that is COMPLETELY visible — its number, its full text, and all of its options on screen — output exactly one line:

Q<number>: <the exact text of the correct option>{{explain}}

Rules:

- Skip any question clipped at the top or bottom of the image; the next
  screenful will show it in full.
- Use the question's own number from the image, not a running count.
- Output only those lines. No preamble, no summary, no markdown fences.
- If the image contains no complete question, output nothing at all.
