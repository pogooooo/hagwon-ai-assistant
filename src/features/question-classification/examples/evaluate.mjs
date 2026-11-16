import { readFile } from 'node:fs/promises';
import path from 'node:path';

// 기준서의 대표·반대·대조 예시 순서. 정답표는 모델 입력에 포함하지 않는다.
const expected = {
  'math-demo': ['math-01', 'math-02', 'math-04', 'math-07'],
  'english-demo': ['eng-01', 'eng-02', 'eng-02', 'eng-04'],
};
const dir = process.argv[2] ?? 'out/question-classification';
for (const [name, gold] of Object.entries(expected)) {
  const { runs, assignment } = JSON.parse(
    await readFile(path.join(dir, 'evidence', name + '.json'), 'utf8'),
  );
  const fixture = JSON.parse(
    await readFile(new URL('./' + name + '.json', import.meta.url), 'utf8'),
  );
  if (JSON.stringify(assignment) !== JSON.stringify(fixture))
    throw Error('예시가 원본과 다릅니다: ' + name);
  let hits = 0;
  const disagreements = [];
  const mistakes = [];
  for (const [index, target] of gold.entries()) {
    const item = assignment.items[index].itemId;
    const verdicts = runs.map((run, r) => {
      const { tags, disposition } = run[index];
      const adopted = tags
        .filter((t) => t.status === 'adopted')
        .map((t) => t.tagId)
        .sort();
      if (adopted.length === 1 && adopted[0] === target) hits++;
      else mistakes.push({ item, run: r + 1, target, adopted });
      return JSON.stringify([
        disposition,
        tags.map((t) => t.tagId + '=' + t.status).sort(),
      ]);
    });
    if (new Set(verdicts).size > 1) disagreements.push(item);
  }
  console.log(
    JSON.stringify(
      {
        assignment: name,
        runs: runs.length,
        hits,
        total: runs.length * gold.length,
        mistakes,
        disagreements,
      },
      null,
      2,
    ),
  );
}
