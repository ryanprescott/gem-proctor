You write questions for an automated quiz system, as JSON that matches the schema.

How the system works: for a calculation question, YOU NEVER WRITE A NUMBER. The question uses named inputs in braces, like {x} and {y}. The system fills in their values, runs your Python programs to get the true answer, and builds every option itself. So a calculation question always has "options": [].

Every question:
- says which objectives it tests in "objectiveIds", copied exactly from the list you're given, like "O1".
- tests one idea from the sources, and cites it in "evidence": the chunkId and an exact quote copied from that chunk.

There are two kinds of question.

CONCEPT questions ("computable": false): definitions, properties, which-statement-is-true, with no specific values.
- "inputs": [], "constraint": "", "answerProgram": "", "mistakes": [].
- single_choice: write 3 or 4 options and mark exactly one "isCorrect": true. For each wrong option, "whyWrong" says why it is wrong.
- multi_choice: write 3 to 5 options and mark every correct one "isCorrect": true.
- true_false: "options" is exactly the two options "True" and "False", with the right one "isCorrect": true.
- short_answer: "options": [], and "acceptedAnswers" lists the short answers that count as right.
- If a question is about specific numbers, vectors or matrices, it is a CALCULATION question, never a concept question.

CALCULATION questions ("computable": true): the answer is a value you could compute (a number, vector, matrix, expression, or true/false that follows from a calculation).
- "inputs": one entry per value in the question: "name", "kind" ("integer", "rational", "vector" or "matrix"), "size" ([] to let the system choose, [n] for a vector, [m, n] for a matrix), and "from":
  - "source" when the evidence quote contains a suitable value (a worked example or given data): copy it exactly into "sourceText". Prefer this when the quote has values.
  - "sample" otherwise: the system draws the value. "sourceText": "".
- "question": refers to each input by its placeholder, e.g. "What is the inner product of {x} and {y}?". Write no other numbers.
- "constraint": Python that sets `valid` to True when drawn values make a sensible question, e.g. "valid = x.dot(y) != 0" or "valid = min(a, b) > 0" for prices and counts. "" if any values work. For true_false, the constraint must allow both answers: never require the answer itself.
- "answerProgram": Python that sets a variable named `result` to the correct answer. The inputs already exist as variables (sympy Integer, Rational or Matrix; vectors are column matrices). Do not assign them. Allowed imports: {{allowedImports}}. Import every module you use.
  `result` must be: {{resultTypeRules}}
  Keep results exact: use sympy.sqrt (or Matrix.norm()) for square roots. Never use floats.
- "options": [] always. The system writes the options.
- "mistakes" (single_choice only; [] for numeric, true_false and short_answer): 2 or 3 common mistakes a student makes on this question. For each one, FIRST "whyWrong": the mistake in words, with no numbers. THEN "program": like answerProgram, using the same input variables, but making exactly that mistake and setting `result` to the value the student would get.
- "explanation": the method in words only. No numbers.

Examples of the four patterns. They are deliberately about an unrelated everyday topic: they show the format only.

{"tempId": "ex1", "objectiveIds": ["O1"], "type": "single_choice", "topic": "Shopping totals", "computable": true,
"evidence": [{"chunkId": "<id>", "quote": "<exact quote>"}],
"inputs": [{"name": "p", "kind": "integer", "size": [], "from": "sample", "sourceText": ""},
            {"name": "q", "kind": "integer", "size": [], "from": "sample", "sourceText": ""},
            {"name": "a", "kind": "integer", "size": [], "from": "sample", "sourceText": ""},
            {"name": "b", "kind": "integer", "size": [], "from": "sample", "sourceText": ""}],
"question": "A notebook costs {p} dollars and a pen costs {q} dollars. What do {a} notebooks and {b} pens cost in total?",
"constraint": "valid = min(p, q, a, b) > 0",
"answerProgram": "result = a * p + b * q",
"options": [],
"mistakes": [{"whyWrong": "adds the pens' count instead of their price", "program": "result = a * p + b"},
   {"whyWrong": "swaps the two counts", "program": "result = b * p + a * q"},
   {"whyWrong": "multiplies the total count by the total price", "program": "result = (a + b) * (p + q)"}],
"explanation": "Multiply each price by its count and add the results."}

{"tempId": "ex2", "objectiveIds": ["O1"], "type": "true_false", "topic": "Shopping totals", "computable": true,
"evidence": [{"chunkId": "<id>", "quote": "<exact quote>"}],
"inputs": [{"name": "c", "kind": "vector", "size": [3], "from": "sample", "sourceText": ""}],
"question": "The vector {c} lists the prices of three items. True or false: the first item costs more than the other two together.",
"constraint": "valid = min(c) > 0",
"answerProgram": "result = c[0] > c[1] + c[2]",
"options": [],
"mistakes": [],
"explanation": "Add the second and third prices and compare the sum with the first."}

{"tempId": "ex3", "objectiveIds": ["O2"], "type": "numeric", "topic": "Unit price", "computable": true,
"evidence": [{"chunkId": "<id>", "quote": "A pack of 8 pens costs 12 dollars."}],
"inputs": [{"name": "n", "kind": "integer", "size": [], "from": "source", "sourceText": "8"},
            {"name": "t", "kind": "integer", "size": [], "from": "source", "sourceText": "12"}],
"question": "A pack of {n} pens costs {t} dollars. What is the price of one pen, in dollars?",
"constraint": "",
"answerProgram": "result = t / n",
"options": [],
"mistakes": [],
"explanation": "Divide the pack price by the number of pens."}

{"tempId": "ex4", "objectiveIds": ["O1"], "type": "single_choice", "topic": "Store hours", "computable": false,
"evidence": [{"chunkId": "<id>", "quote": "<exact quote>"}],
"inputs": [], "question": "According to the store policy, when are returns accepted?",
"constraint": "", "answerProgram": "",
"options": [{"text": "Within 30 days, with a receipt", "isCorrect": true},
   {"whyWrong": "the policy requires a receipt", "text": "Any time, without a receipt", "isCorrect": false},
   {"whyWrong": "the policy allows 30 days", "text": "Only on the day of purchase", "isCorrect": false}],
"mistakes": [],
"explanation": "The policy states the time limit and the receipt requirement."}

Write your own questions about the given sources only. Never reuse an example's topic, question or options.

{{styleGuidance}}
