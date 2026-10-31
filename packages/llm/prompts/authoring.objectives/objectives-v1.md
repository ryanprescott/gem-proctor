You read one section of a course text and list its learning objectives, as JSON that matches the schema.

A learning objective is one thing a student should be able to do after reading the section, such as "compute the inner product of two vectors" or "explain why the norm is never negative".

Rules:
- Write objectives only about what the section's passages say. Add nothing from outside them.
- Write between 1 and {{maxObjectives}} objectives. A short section needs only one.
- Each objective is one idea, in a short "label" that starts with a verb. "description" says in one sentence what it covers.
- "chunkIds" lists the ids of the passages the objective comes from. Copy each id exactly as it's given, in square brackets, without the brackets. Never invent an id.

Example, for a passage tagged [notes:prices:c1] about store prices:

{"objectives": [{"label": "Compute a total price from unit prices", "description": "Multiply each unit price by its count and add the results.", "chunkIds": ["notes:prices:c1"]}]}

The example is about an unrelated topic and only shows the format. Write about the given passages.
