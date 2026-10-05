// Review sheets for the G-I2 / G-C2 task sets (docs/workflow-policy.md 4): one Markdown file per suite, generated from
// task.json, rubric.json, meta.json and the verify/grade scripts, so the sheet always shows what the run will use.
//   node experiments/workflow/review-sheet.mjs   → fixtures/investigation/REVIEW.md, fixtures/creation/REVIEW.md
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const CATEGORY = { cause: '원인 분석', repo: 'repo 질문', compare: '기술 비교', arch: '아키텍처 평가', counter: '반례 판단' };

function investigation(root) {
  const tasks = readdirSync(root).filter(name => existsSync(join(root, name, 'task.json'))).sort();
  const rows = [], blocks = [];
  for (const id of tasks) {
    const task = read(join(root, id, 'task.json')), rubric = read(join(root, id, 'rubric.json')), meta = read(join(root, id, 'meta.json'));
    let verified = meta.source ? '기존 suite 과제(검증된 원본 복사)' : '';
    if (existsSync(join(root, id, 'verify.mjs'))) {
      try { execFileSync(process.execPath, ['verify.mjs'], { cwd: join(root, id), stdio: 'pipe' }); verified = 'verify.mjs 통과(정답의 사실관계를 코드 실행으로 확인)'; }
      catch (error) { verified = `**verify.mjs 실패**: ${String(error.stderr || error.message).split('\n')[0]}`; }
    }
    const conclusion = rubric.items.find(item => item.id === 'conclusion')?.criterion ?? rubric.items.at(-1).criterion;
    rows.push(`| ${id} | ${CATEGORY[meta.category]} | ${task.language} | ${meta.trap ? '함정' : ''} | ${conclusion.replace(/\|/g, '/').slice(0, 110)} |`);
    blocks.push([
      `### ${id} — ${task.title}`,
      `- 범주: ${CATEGORY[meta.category]} · 언어: ${task.language} · 함정: ${meta.trap ?? '없음'}`,
      `- 검증: ${verified}`,
      '', '**질문 (모델이 받는 그대로)**', '', `> ${task.instruction}`,
      '', '**정답 (judge가 보는 reference)**', '', `> ${rubric.referenceAnswer}`,
      '', '**채점 항목 (모두 충족해야 통과; `conclusion`이 결론 정오)**', '',
      ...rubric.items.map(item => `- \`${item.id}\`: ${item.criterion}`),
      '', '- [ ] 승인   - [ ] 수정 필요: ', '',
    ].join('\n'));
  }
  const counts = Object.entries(CATEGORY).map(([key, label]) => `${label} ${tasks.filter(id => read(join(root, id, 'meta.json')).category === key).length}`).join(', ');
  const traps = tasks.filter(id => read(join(root, id, 'meta.json')).trap).length;
  return [
    '# G-I2 investigation 과제 검토표', '',
    `${tasks.length}과제: ${counts}. 함정 ${traps}개. 생성: \`node experiments/workflow/review-sheet.mjs\` (JSON에서 다시 만들어짐; 이 파일을 직접 고치지 말고 체크·메모만).`, '',
    '| id | 범주 | 언어 | 함정 | 결론 기준 |', '|---|---|---|---|---|', ...rows, '', ...blocks,
  ].join('\n');
}

function creation(root) {
  const tasks = readdirSync(root).filter(name => existsSync(join(root, name, 'task.json'))).sort();
  const rows = [], blocks = [];
  for (const id of tasks) {
    const task = read(join(root, id, 'task.json')), meta = read(join(root, id, 'meta.json'));
    const grade = readFileSync(join(root, id, 'grade.mjs'), 'utf8').split('const text = path')[1].split('\n').slice(1).join('\n').replace(/\nif \(failures\.length\)[\s\S]*$/, '').trim();
    rows.push(`| ${id} | ${meta.value === 'high' ? '고가치 (1차 비교)' : '단순 (escalation 점검)'} | ${task.title} |`);
    blocks.push([
      `### ${id} — ${task.title}`,
      `- 구분: ${meta.value === 'high' ? '고가치: C0 vs C1 1차 비교 대상' : '단순: auto escalation에서 candidates 1이 맞는지 점검'}`,
      '', '**지시 (모델이 받는 그대로)**', '', `> ${task.instruction}`,
      '', `**맹검 비교 기준 (judge)**: ${meta.rubric}`,
      '', '**하드 제약 (grade.mjs가 결정적으로 검사)**', '', '```js', grade, '```',
      '', '- [ ] 승인   - [ ] 수정 필요: ', '',
    ].join('\n'));
  }
  return [
    '# G-C2 creation 과제 검토표', '',
    `${tasks.length}과제 (고가치 ${tasks.filter(id => read(join(root, id, 'meta.json')).value === 'high').length}, 단순 ${tasks.filter(id => read(join(root, id, 'meta.json')).value !== 'high').length}). 모든 grade.mjs는 시작 상태에서 실패하고, 조건을 만족하는 합성 결과물에서 통과함을 확인했다. 공통 저장소: Ember Hollow(docs/art-direction.md).`, '',
    '| id | 구분 | 제목 |', '|---|---|---|', ...rows, '', ...blocks,
  ].join('\n');
}

writeFileSync('fixtures/investigation/REVIEW.md', `${investigation('fixtures/investigation')}\n`);
writeFileSync('fixtures/creation/REVIEW.md', `${creation('fixtures/creation')}\n`);
console.log('wrote fixtures/investigation/REVIEW.md, fixtures/creation/REVIEW.md');
