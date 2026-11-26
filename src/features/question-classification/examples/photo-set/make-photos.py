# 기준서 예시 55문항(rubric-set)을 교재 쪽 모양으로 인쇄하고 휴대폰 사진처럼 변형한다.
# 정답(쪽수·문항 번호·원문·유형)을 알고 있는 사진 평가 세트를 만들기 위한 생성기다.
#   python make-photos.py            # 같은 폴더에 page-*.jpg와 manifest.json 생성
# 난수 시드를 고정했으므로 다시 실행해도 같은 사진이 나온다.
import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
RUBRIC = HERE.parent / 'rubric-set'
FONTS = Path('C:/Windows/Fonts')
W, H = 1240, 1754  # A4, 150dpi


def font(size, bold=False):
    return ImageFont.truetype(str(FONTS / ('malgunbd.ttf' if bold else 'malgun.ttf')), size)


def load(name):
    return json.loads((RUBRIC / (name + '.json')).read_text(encoding='utf8'))['items']


def split_english(text):
    """영어 문항 원문을 지문과 발문으로 나눈다. 발문은 첫 한글 단어부터다."""
    body = text
    prefix = ''
    if body.startswith('[듣기 대본]'):
        prefix, body = '[듣기 대본] ', body[len('[듣기 대본] '):]
    for i, ch in enumerate(body):
        if '가' <= ch <= '힣':
            start = body.rfind(' ', 0, i) + 1
            # 따옴표로 시작하는 발문('Its errors'에서 …)은 여는 따옴표부터 발문이다.
            if body[:start].count('‘') > body[:start].count('’'):
                start = body.rfind('‘', 0, start)
            return (prefix + body[:start]).strip(), body[start:].strip()
    return (prefix + body).strip(), ''


def wrap(draw, text, fnt, width):
    text = text.replace('−', '-')
    lines, line = [], ''
    for word in text.split(' '):
        trial = (line + ' ' + word).strip()
        if draw.textlength(trial, font=fnt) <= width or not line:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def number_label(n, style):
    return {'pad4': f'{int(n):04d}', 'dot': f'{n}.', 'plain': f'{n}'}[style]


def render_page(page):
    img = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(img)
    body, small, num = font(27), font(22), font(28, True)
    # 머리글: 단원 번호와 쪽수 외의 숫자를 일부러 넣어 쪽수 혼동을 시험한다.
    d.text((80, 50), page['header'], font=small, fill=(90, 90, 90))
    d.line((80, 90, W - 80, 90), fill=(150, 150, 150), width=2)
    folio = str(page['printedPage'])
    if page['folio'] == 'top':
        d.text((W - 80 - d.textlength(folio, font=num), 46), folio, font=num, fill='black')
    else:
        x = 80 if page['printedPage'] % 2 == 0 else W - 80 - d.textlength(folio, font=num)
        d.text((x, H - 90), folio, font=num, fill='black')
    cols = page['columns']
    gap = 60
    col_w = (W - 160 - gap * (cols - 1)) // cols
    blocks = page['blocks']
    per_col = math.ceil(len(blocks) / cols)
    for c in range(cols):
        x0 = 80 + c * (col_w + gap)
        y = 130
        if cols == 2 and c == 1:
            d.line((x0 - gap // 2, 120, x0 - gap // 2, H - 130), fill=(170, 170, 170), width=2)
        for block in blocks[c * per_col:(c + 1) * per_col]:
            if block['kind'] == 'passage':
                d.text((x0, y), block['label'], font=body, fill='black')
                y += 44
                lines = wrap(d, block['text'], body, col_w - 30)
                top = y
                y += 14
                for line in lines:
                    d.text((x0 + 16, y), line, font=body, fill='black')
                    y += 40
                d.rectangle((x0, top, x0 + col_w - 6, y + 10), outline=(80, 80, 80), width=2)
                y += 40
                continue
            label = number_label(block['displayNumber'], page['numberStyle'])
            d.text((x0, y), label, font=num, fill=(30, 60, 140))
            indent = int(d.textlength(label, font=num)) + 14
            for i, line in enumerate(wrap(d, block['text'], body, col_w - indent)):
                d.text((x0 + indent, y), line, font=body, fill='black')
                y += 40
            y += block.get('space', 150)  # 풀이 공간
    return img


def photograph(img, rng):
    """평평한 인쇄면을 휴대폰 사진처럼 기울이고 흐리게 만든다."""
    pad = 90
    canvas = Image.new('RGB', (W + 2 * pad, H + 2 * pad), (120, 110, 100))
    canvas.paste(img, (pad, pad))
    # 그림자 경사: 한쪽이 어둡다.
    shade = Image.linear_gradient('L').rotate(rng.choice([0, 90, 180, 270])).resize(canvas.size)
    shade = shade.point(lambda v: 255 - v * 0.22)
    canvas = Image.composite(canvas, Image.new('RGB', canvas.size, 'black'), shade)
    canvas = canvas.rotate(rng.uniform(-3.5, 3.5), resample=Image.BICUBIC, expand=False, fillcolor=(120, 110, 100))
    cw, ch = canvas.size
    j = lambda: rng.uniform(-40, 40)
    quad = (j(), j(), j(), ch + j(), cw + j(), ch + j(), cw + j(), j())
    canvas = canvas.transform(canvas.size, Image.QUAD, quad, resample=Image.BICUBIC, fillcolor=(120, 110, 100))
    canvas = canvas.filter(ImageFilter.GaussianBlur(rng.uniform(0.6, 1.2)))
    scale = 1500 / max(canvas.size)
    return canvas.resize((int(cw * scale), int(ch * scale)), Image.LANCZOS)


def english_blocks(items):
    """같은 지문을 쓰는 연속 문항은 [n~m] 지문 상자 하나로 묶는다(교재 형식)."""
    blocks, i = [], 0
    while i < len(items):
        passage, _ = split_english(items[i]['text'])
        group = [items[i]]
        while i + len(group) < len(items) and split_english(items[i + len(group)]['text'])[0] == passage:
            group.append(items[i + len(group)])
        nums = [g['displayNumber'] for g in group]
        label = f'[{nums[0]}~{nums[-1]}] 다음 글을 읽고 물음에 답하시오.' if len(group) > 1 else f'[{nums[0]}] 다음 글을 읽고 물음에 답하시오.'
        blocks.append({'kind': 'passage', 'label': label, 'text': passage})
        for g in group:
            blocks.append({'kind': 'item', 'itemId': g['itemId'], 'displayNumber': g['displayNumber'],
                           'text': split_english(g['text'])[1], 'space': 70})
        i += len(group)
    return blocks


def main():
    rng = random.Random(20261115)
    math_items = load('math-rubric-1') + load('math-rubric-2') + load('math-rubric-3')
    eng_items = load('english-rubric-1') + load('english-rubric-2') + load('english-rubric-3')
    pages = []
    # 수학: 6쪽, 쪽마다 4~5문항. 번호 형식과 단 수를 바꿔 가며 경계 분리를 시험한다.
    math_chunks = [math_items[0:4], math_items[4:8], math_items[8:13], math_items[13:18], math_items[18:22], math_items[22:25]]
    styles = ['pad4', 'dot', 'pad4', 'plain', 'dot', 'pad4']
    for k, chunk in enumerate(math_chunks):
        pages.append({
            'subject': 'M', 'printedPage': 24 + k, 'header': f'Ⅱ. 함수와 미분  |  0{k % 3 + 1} 유형 연습',
            'folio': 'bottom', 'numberStyle': styles[k], 'columns': 2 if k % 2 else 1,
            'blocks': [{'kind': 'item', 'itemId': i['itemId'], 'displayNumber': i['displayNumber'], 'text': i['text']} for i in chunk],
        })
    # 영어: 6쪽. 공유 지문은 한 번만 인쇄하고 각 문항 정답 원문에는 지문을 포함한다.
    eng_chunks = [eng_items[0:4], eng_items[4:10], eng_items[10:16], eng_items[16:20], eng_items[20:24], eng_items[24:30]]
    for k, chunk in enumerate(eng_chunks):
        pages.append({
            'subject': 'E', 'printedPage': 112 + k, 'header': f'UNIT {k + 3}  Reading Practice  (2026 개정)',
            'folio': 'top' if k % 2 else 'bottom', 'numberStyle': 'dot' if k % 2 else 'plain',
            'columns': 2 if k in (1, 4) else 1, 'blocks': english_blocks(chunk),
        })
    texts = {i['itemId']: i['text'] for i in math_items + eng_items}
    manifest = []
    for n, page in enumerate(pages, 1):
        name = f'page-{n:02d}-{page["subject"]}{page["printedPage"]}.jpg'
        photograph(render_page(page), rng).save(HERE / name, quality=72)
        manifest.append({
            'image': name, 'subject': page['subject'], 'printedPage': page['printedPage'],
            'layout': {'columns': page['columns'], 'numberStyle': page['numberStyle'], 'folio': page['folio']},
            'items': [{'itemId': b['itemId'], 'printedNumber': number_label(b['displayNumber'], page['numberStyle']).rstrip('.'),
                       'text': texts[b['itemId']]} for b in page['blocks'] if b['kind'] == 'item'],
        })
    (HERE / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(len(manifest), 'pages,', sum(len(p['items']) for p in manifest), 'items')


if __name__ == '__main__':
    main()
