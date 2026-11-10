#!/usr/bin/env python3
"""商店文案体检:字符上限 + 该填而没填的占位符。

★为什么值得写:App Store Connect 的字符上限是**提交时**才拒的,而那时你已经等了
  一次构建、一次上传、一次处理。在本机 200ms 就能知道的事,别拿到苹果那边去知道。

★中文字符按 **1 个**算(苹果按 Unicode 码点计数,不是字节)。用 len(str) 正好。

  ./scripts/check-metadata.py
"""
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'metadata')

# 字段 → 上限。None = 不限长,但仍检查占位符。
LIMITS = {
    'name': 30,
    'subtitle': 30,
    'keywords': 100,
    'promotional_text': 170,
    'description': 4000,
    'release_notes': 4000,
}

# 提交前必须替换掉的记号。★审核备注里留着 <待填> 就等于告诉审核员「我没准备好」。
#
# ★`{{...}}` 是**注入式**占位符(审核账号那三项),与上面那种性质不同:
#   它**应该**一直留在仓里 —— 真值在 .asc/review-account.json(gitignore),
#   由 `asc.py push-review` 推送时才替换。因为这个仓会镜像到 Gitee、也会在客户服务器上
#   检出,而 git 历史是永久的:密码一旦提交,日后改了也抹不掉旧的。
#   所以这里把它记成「预期存在」而不是「待办」—— 但**必须确认它们还在**:
#   哪天有人图省事把真密码写进正文,这条会红。
PLACEHOLDERS = ('<待填', 'TODO', 'XXX')
INJECTED = ('{{SERVER}}', '{{PHONE}}', '{{PASSWORD}}')

fails: list[str] = []
warns: list[str] = []


def check_text(rel: str, field: str, text: str) -> None:
    limit = LIMITS.get(field)
    n = len(text)
    if limit and n > limit:
        fails.append(f'{rel}:{n} 字符,超上限 {limit}(多了 {n - limit})')
    elif limit:
        room = limit - n
        flag = '  ← 快满了' if room <= 3 else ''
        print(f'  {rel:34s} {n:>5}/{limit}{flag}')
    else:
        print(f'  {rel:34s} {n:>5}')
    for ph in PLACEHOLDERS:
        if ph in text:
            warns.append(f'{rel}:还有占位符 {ph!r} —— 提交前必须替换')
            break
    # ★注入式占位符必须**还在**。少了一个,通常意味着有人把真凭据写进了正文 ——
    #   而这个仓会镜像到 Gitee、也会在客户服务器上检出。这条检查的方向和上面那条相反。
    if rel == 'review-notes.txt':
        gone = [x for x in INJECTED if x not in text]
        if gone:
            warns.append(
                f'{rel}:注入式占位符不见了 {gone} —— 审核账号的真值不许写进仓库,'
                f'放 .asc/review-account.json,由 asc.py push-review 注入')


def main() -> int:
    if not os.path.isdir(ROOT):
        print('找不到 metadata/', file=sys.stderr)
        return 1

    print('字段长度:')
    for locale in sorted(os.listdir(ROOT)):
        d = os.path.join(ROOT, locale)
        if not os.path.isdir(d):
            continue
        missing = [f for f in LIMITS if not os.path.exists(os.path.join(d, f'{f}.txt'))]
        if missing:
            fails.append(f'{locale}/ 缺文件:{", ".join(sorted(missing))}')
        for fn in sorted(os.listdir(d)):
            if not fn.endswith('.txt'):
                continue
            with open(os.path.join(d, fn), encoding='utf-8') as fh:
                check_text(f'{locale}/{fn}', fn[:-4], fh.read().strip())

    notes = os.path.join(ROOT, 'review-notes.txt')
    if os.path.exists(notes):
        with open(notes, encoding='utf-8') as fh:
            check_text('review-notes.txt', 'review_notes', fh.read().strip())
    else:
        fails.append('缺 review-notes.txt —— 见 metadata/README.md,这是被拒概率最高的一处')

    # keywords 的两个惯常错法
    for locale in sorted(os.listdir(ROOT)):
        kw_path = os.path.join(ROOT, locale, 'keywords.txt')
        if not os.path.exists(kw_path):
            continue
        with open(kw_path, encoding='utf-8') as fh:
            kw = fh.read().strip()
        if re.search(r',\s+', kw):
            fails.append(f'{locale}/keywords.txt:逗号后有空格 —— 空格也占字符,苹果不会替你去掉')
        words = [w for w in kw.split(',') if w]
        dupes = {w for w in words if words.count(w) > 1}
        if dupes:
            fails.append(f'{locale}/keywords.txt:关键词重复 {sorted(dupes)}')

    print()
    for w in warns:
        print(f'⚠ {w}')
    for f in fails:
        print(f'✗ {f}')
    if fails:
        print(f'\n{len(fails)} 项要修')
        return 1
    print('✓ 长度与格式都合规' + (f'(另有 {len(warns)} 处占位符待替换)' if warns else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
