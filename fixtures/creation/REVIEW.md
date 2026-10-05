# G-C2 creation 과제 검토표

12과제 (고가치 8, 단순 4). 모든 grade.mjs는 시작 상태에서 실패하고, 조건을 만족하는 합성 결과물에서 통과함을 확인했다. 공통 저장소: Ember Hollow(docs/art-direction.md).

| id | 구분 | 제목 |
|---|---|---|
| c01-boss-concept | 고가치 (1차 비교) | Final boss concept |
| c02-logo | 고가치 (1차 비교) | Game logo |
| c03-thumbnail | 고가치 (1차 비교) | Launch trailer thumbnail |
| c04-theme | 고가치 (1차 비교) | Night market launcher theme |
| c05-mode-names | 고가치 (1차 비교) | Names for the co-op mode |
| c06-tagline | 고가치 (1차 비교) | Store tagline |
| c07-title-art | 고가치 (1차 비교) | Title screen key art |
| c08-card-frame | 고가치 (1차 비교) | Relic card frame |
| c09-stamina-icon | 단순 (escalation 점검) | Stamina potion icon |
| c10-icon-32 | 단순 (escalation 점검) | 32 px ember potion |
| c11-favicon | 단순 (escalation 점검) | Favicon from the brand mark |
| c12-disabled-button | 단순 (escalation 점검) | Disabled button state |

### c01-boss-concept — Final boss concept
- 구분: 고가치: C0 vs C1 1차 비교 대상

**지시 (모델이 받는 그대로)**

> Create the concept for Ember Hollow's final boss. Deliver one concept illustration at assets/concepts/boss.png (1024x1024 PNG) and a one-page design note at docs/boss.md with the boss's name, its silhouette idea, two attack patterns and its weakness. It must fit docs/art-direction.md.

**맹검 비교 기준 (judge)**: compliance (hard constraints and instructions), quality (craft), fit (art direction and audience); distinct, readable silhouette; attacks and weakness consistent with the image

**하드 제약 (grade.mjs가 결정적으로 검사)**

```js
await image('assets/concepts/boss.png', 1024, 1024);
const note = text('docs/boss.md') ?? '';
check(note.length > 200, 'docs/boss.md missing or too short');
check(/weakness/i.test(note), 'docs/boss.md has no weakness');
```

- [ ] 승인   - [ ] 수정 필요: 

### c02-logo — Game logo
- 구분: 고가치: C0 vs C1 1차 비교 대상

**지시 (모델이 받는 그대로)**

> Design the Ember Hollow game logo: assets/brand/logo.png, 1024x512 PNG with a transparent background, the title EMBER HOLLOW clearly legible. Follow the typography and palette in docs/art-direction.md.

**맹검 비교 기준 (judge)**: compliance (hard constraints and instructions), quality (craft), fit (art direction and audience); title legible and spelled exactly EMBER HOLLOW

**하드 제약 (grade.mjs가 결정적으로 검사)**

```js
const logo = await image('assets/brand/logo.png', 1024, 512);
if (logo) check(await alphaRegion(logo.file, 0, 0, 64, 64) > 0.9, 'logo corner is not transparent');
```

- [ ] 승인   - [ ] 수정 필요: 

### c03-thumbnail — Launch trailer thumbnail
- 구분: 고가치: C0 vs C1 1차 비교 대상

**지시 (모델이 받는 그대로)**

> Make the thumbnail for the Ember Hollow launch trailer: assets/video/thumbnail.png, 1280x720 PNG. It must show the words OUT NOW and read well at small sizes on a video platform.

**맹검 비교 기준 (judge)**: compliance (hard constraints and instructions), quality (craft), fit (art direction and audience); OUT NOW legible at 320x180; one clear focal point

**하드 제약 (grade.mjs가 결정적으로 검사)**

```js
await image('assets/video/thumbnail.png', 1280, 720);
```

- [ ] 승인   - [ ] 수정 필요: 

### c04-theme — Night market launcher theme
- 구분: 고가치: C0 vs C1 1차 비교 대상

**지시 (모델이 받는 그대로)**

> Create a 'night market' colour theme for the game launcher: themes/night-market.css must define every CSS custom property listed in themes/_template.css with a hex colour, and the contrast ratio of --text on --bg must be at least 4.5:1. Add a short section to docs/themes.md explaining the theme.

**맹검 비교 기준 (judge)**: compliance (hard constraints and instructions), quality (craft), fit (art direction and audience); coherent, distinctive palette that still belongs to Ember Hollow

**하드 제약 (grade.mjs가 결정적으로 검사)**

```js
const template = text('themes/_template.css') ?? '';
const theme = text('themes/night-market.css');
check(theme !== undefined, 'themes/night-market.css missing');
const names = [...template.matchAll(/(--[a-z-]+)\s*:/g)].map(match => match[1]);
const values = Object.fromEntries([...(theme ?? '').matchAll(/(--[a-z-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)].map(match => [match[1], match[2]]));
for (const name of names) check(values[name], `${name} missing or not a hex colour`);
const lum = hex => { let h = hex.slice(1); if (h.length === 3) h = [...h].map(c => c + c).join(''); const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
if (values['--text'] && values['--bg']) { const [a, b] = [lum(values['--text']), lum(values['--bg'])].sort((x, y) => y - x); check((a + 0.05) / (b + 0.05) >= 4.5, 'contrast of --text on --bg below 4.5'); }
check(/night market/i.test(text('docs/themes.md') ?? ''), 'docs/themes.md has no night market section');
```

- [ ] 승인   - [ ] 수정 필요: 

### c05-mode-names — Names for the co-op mode
- 구분: 고가치: C0 vs C1 1차 비교 대상

**지시 (모델이 받는 그대로)**

> Propose names for Ember Hollow's new two-player co-op mode in docs/naming.md. List exactly 5 candidates, one per line in the form `- **Name** — one-line rationale`; each name at most 14 characters and different from every existing mode name in data/modes.json. Mark the one you recommend by appending (recommended) to its line.

**맹검 비교 기준 (judge)**: compliance (hard constraints and instructions), quality (craft), fit (art direction and audience); memorable, conveys co-op, fits the world's tone

**하드 제약 (grade.mjs가 결정적으로 검사)**

```js
const doc = text('docs/naming.md') ?? '';
const lines = doc.split('\n').filter(line => /^- \*\*.+?\*\* — /.test(line));
check(lines.length === 5, `expected 5 candidate lines, found ${lines.length}`);
const existing = JSON.parse(text('data/modes.json')).modes.map(name => name.toLowerCase());
for (const line of lines) {
  const name = /^- \*\*(.+?)\*\*/.exec(line)[1].trim();
  check(name.length <= 14, `${name} longer than 14 characters`);
  check(!existing.includes(name.toLowerCase()), `${name} already exists`);
}
check(lines.filter(line => /\(recommended\)\s*$/.test(line)).length === 1, 'exactly one line must end with (recommended)');
```

- [ ] 승인   - [ ] 수정 필요: 

### c06-tagline — Store tagline
- 구분: 고가치: C0 vs C1 1차 비교 대상

**지시 (모델이 받는 그대로)**

> Write the store-page tagline for Ember Hollow in Korean and English: store/tagline.json as {"ko": "...", "en": "..."}. English at most 60 characters, Korean at most 30 characters, and neither may use the words epic or ultimate (or 에픽, 궁극).

**맹검 비교 기준 (judge)**: compliance (hard constraints and instructions), quality (craft), fit (art direction and audience); evocative, specific to this game, natural in both languages

**하드 제약 (grade.mjs가 결정적으로 검사)**

```js
let tagline; try { tagline = JSON.parse(text('store/tagline.json') ?? ''); } catch { failures.push('store/tagline.json missing or invalid JSON'); }
if (tagline) {
  check(typeof tagline.en === 'string' && tagline.en.length > 0 && tagline.en.length <= 60, 'en missing or longer than 60');
  check(typeof tagline.ko === 'string' && tagline.ko.length > 0 && [...tagline.ko].length <= 30, 'ko missing or longer than 30');
  check(!/\b(epic|ultimate)\b/i.test(tagline.en ?? '') && !/에픽|궁극/.test(tagline.ko ?? ''), 'banned word used');
}
```

- [ ] 승인   - [ ] 수정 필요: 

### c07-title-art — Title screen key art
- 구분: 고가치: C0 vs C1 1차 비교 대상

**지시 (모델이 받는 그대로)**

> Paint the title-screen background: assets/ui/title-bg.png, 1920x1080 PNG. Keep the top-centre area (x 640-1280, y 0-360) calm and free of important detail because the logo goes there; the ember light should lead the eye toward it.

**맹검 비교 기준 (judge)**: compliance (hard constraints and instructions), quality (craft), fit (art direction and audience); logo zone is calm; composition leads to the logo zone

**하드 제약 (grade.mjs가 결정적으로 검사)**

```js
await image('assets/ui/title-bg.png', 1920, 1080);
```

- [ ] 승인   - [ ] 수정 필요: 

### c08-card-frame — Relic card frame
- 구분: 고가치: C0 vs C1 1차 비교 대상

**지시 (모델이 받는 그대로)**

> Design the frame for relic cards: assets/ui/card-frame.png, 512x768 PNG. The art window (x 48-463, y 96-479) must be fully transparent so the card art shows through; the rest is the frame, in the game's pixel-art style.

**맹검 비교 기준 (judge)**: compliance (hard constraints and instructions), quality (craft), fit (art direction and audience); frame reads as a relic card; style matches the sprites

**하드 제약 (grade.mjs가 결정적으로 검사)**

```js
const frame = await image('assets/ui/card-frame.png', 512, 768);
if (frame && frame.meta.width === 512 && frame.meta.height === 768) {
  check(await alphaRegion(frame.file, 48, 96, 416, 384) >= 0.97, 'art window is not transparent');
  check(await alphaRegion(frame.file, 0, 0, 512, 40) < 0.9, 'frame border looks empty');
}
```

- [ ] 승인   - [ ] 수정 필요: 

### c09-stamina-icon — Stamina potion icon
- 구분: 단순: auto escalation에서 candidates 1이 맞는지 점검

**지시 (모델이 받는 그대로)**

> Add a stamina potion icon: assets/items/potion-stamina.png, 64x64 PNG with a transparent background, in the same style as the existing potion icons in assets/items/.

**맹검 비교 기준 (judge)**: compliance (hard constraints and instructions), quality (craft), fit (art direction and audience); consistent with the existing potions

**하드 제약 (grade.mjs가 결정적으로 검사)**

```js
const icon = await image('assets/items/potion-stamina.png', 64, 64);
if (icon && icon.meta.width === 64) check(await alphaRegion(icon.file, 0, 0, 8, 8) > 0.9, 'corner not transparent');
```

- [ ] 승인   - [ ] 수정 필요: 

### c10-icon-32 — 32 px ember potion
- 구분: 단순: auto escalation에서 candidates 1이 맞는지 점검

**지시 (모델이 받는 그대로)**

> Make a 32x32 version of assets/items/potion-ember.png at assets/items/potion-ember-32.png (nearest-neighbour scaling, keep the transparency).

**맹검 비교 기준 (judge)**: compliance (hard constraints and instructions), quality (craft), fit (art direction and audience); faithful downscale, still crisp

**하드 제약 (grade.mjs가 결정적으로 검사)**

```js
const icon = await image('assets/items/potion-ember-32.png', 32, 32);
if (icon && icon.meta.width === 32) check(await alphaRegion(icon.file, 0, 0, 4, 4) > 0.9, 'corner not transparent');
```

- [ ] 승인   - [ ] 수정 필요: 

### c11-favicon — Favicon from the brand mark
- 구분: 단순: auto escalation에서 candidates 1이 맞는지 점검

**지시 (모델이 받는 그대로)**

> Create the website favicon from the brand mark assets/brand/mark.png: assets/brand/favicon.png, 48x48 PNG with a transparent background.

**맹검 비교 기준 (judge)**: compliance (hard constraints and instructions), quality (craft), fit (art direction and audience); recognisable at 16-48 px

**하드 제약 (grade.mjs가 결정적으로 검사)**

```js
const icon = await image('assets/brand/favicon.png', 48, 48);
if (icon && icon.meta.width === 48) check(await alphaRegion(icon.file, 0, 0, 4, 4) > 0.9, 'corner not transparent');
```

- [ ] 승인   - [ ] 수정 필요: 

### c12-disabled-button — Disabled button state
- 구분: 단순: auto escalation에서 candidates 1이 맞는지 점검

**지시 (모델이 받는 그대로)**

> Create the disabled state of the launcher button: assets/ui/button-disabled.png, same size and shape as assets/ui/button.png, desaturated grey.

**맹검 비교 기준 (judge)**: compliance (hard constraints and instructions), quality (craft), fit (art direction and audience); same shape; clearly disabled

**하드 제약 (grade.mjs가 결정적으로 검사)**

```js
const base = await sharp(join(dir, 'assets/ui/button.png')).metadata();
const variant = await image('assets/ui/button-disabled.png', base.width, base.height);
if (variant) {
  const { data, info } = await sharp(variant.file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let sat = 0, n = 0;
  for (let i = 0; i < data.length; i += info.channels) { if (data[i + 3] < 128) continue; const [r, g, b] = [data[i], data[i + 1], data[i + 2]]; const max = Math.max(r, g, b), min = Math.min(r, g, b); sat += max ? (max - min) / max : 0; n++; }
  check(n > 0 && sat / n < 0.15, `mean saturation ${(sat / Math.max(n, 1)).toFixed(2)} not grey`);
}
```

- [ ] 승인   - [ ] 수정 필요: 

