#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 questions.json 注入单文件刷题模板，生成可离线使用的 HTML。

用法:
    python build.py questions.json 输出.html [--template 模板路径]

questions.json 结构:
{
  "meta": {
    "title": "课程名",              # 必填，页面标题与卷头
    "key": "gongye-shejishi",      # 可选，localStorage 键后缀；不同课程务必不同
    "source": "你的 docx 题库",     # 可选，说明面板里的来源描述
    "fileBase": "工业设计史",       # 可选，导出 txt 的文件名前缀
    "ocrNote": true                # 可选，false 时隐藏“已修正 OCR 错字”说明
  },
  "questions": [
    {"id": 1, "q": "题干", "opts": ["选项A", "选项B", "选项C", "选项D"], "ans": 2}
  ]
}
ans 是正确选项在 opts 里的下标（从 0 开始）。
"""
import argparse
import json
import os
import re
import sys


def fail(msg):
    print("ERROR: " + msg)
    sys.exit(1)


def sanitize(name):
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", name).strip(" ._")
    return name or "题库"


def slug(name):
    s = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", "-", name).strip("-").lower()
    return s or "quiz"


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        fail("找不到 %s" % path)
    except json.JSONDecodeError as e:
        fail("%s 不是合法 JSON：%s" % (path, e))
    if not isinstance(data, dict):
        fail("questions.json 顶层必须是对象 {meta, questions}")
    return data


def validate(data):
    meta = data.get("meta") or {}
    if not isinstance(meta, dict):
        fail("meta 必须是对象")
    title = str(meta.get("title") or "").strip()
    if not title:
        fail("meta.title 不能为空")

    qs = data.get("questions")
    if not isinstance(qs, list) or not qs:
        fail("questions 必须是非空数组")

    seen_ids, seen_texts = set(), {}
    out = []
    for i, q in enumerate(qs):
        where = "第 %d 题" % (i + 1)
        if not isinstance(q, dict):
            fail(where + " 不是对象")
        qid = q.get("id")
        if qid is None:
            qid = i + 1
        if not isinstance(qid, int) or isinstance(qid, bool) or qid < 1:
            fail(where + " 的 id 必须是正整数")
        if qid in seen_ids:
            fail("id 重复：%d" % qid)
        seen_ids.add(qid)

        text = str(q.get("q") or "").strip()
        if not text:
            fail(where + " 题干为空")
        norm = re.sub(r"\s+", "", text)
        if norm in seen_texts:
            fail("题干重复：#%d 与 #%d 内容相同" % (seen_texts[norm], qid))
        seen_texts[norm] = qid

        opts = q.get("opts")
        if not isinstance(opts, list) or not (2 <= len(opts) <= 8):
            fail(where + " opts 必须是 2–8 个选项的数组")
        clean = []
        for j, o in enumerate(opts):
            o = str(o or "").strip()
            if not o:
                fail(where + " 第 %d 个选项为空" % (j + 1))
            if o in clean:
                fail(where + " 选项重复：%r" % o)
            clean.append(o)

        ans = q.get("ans")
        if not isinstance(ans, int) or isinstance(ans, bool) or not (0 <= ans < len(clean)):
            fail(where + " ans 必须是 0–%d 的整数下标" % (len(clean) - 1))

        out.append({"id": qid, "q": text, "opts": clean, "ans": ans})

    meta["title"] = title
    meta.setdefault("key", slug(title))
    meta.setdefault("fileBase", sanitize(title))
    meta.setdefault("source", "题库文件")
    return meta, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bank", help="questions.json")
    ap.add_argument("output", help="输出 html 路径")
    ap.add_argument("--template", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                      "..", "assets", "template.html"))
    args = ap.parse_args()

    tpl_path = os.path.abspath(args.template)
    try:
        with open(tpl_path, encoding="utf-8") as f:
            tpl = f.read()
    except FileNotFoundError:
        fail("找不到模板 %s（应与 scripts/ 同级的 assets/template.html）" % tpl_path)
    for ph in ("__BANK__", "__META__"):
        if ph not in tpl:
            fail("模板缺少占位符 " + ph)

    meta, questions = validate(load(args.bank))

    def dumps(obj):
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")

    html = tpl.replace("__BANK__", dumps(questions)).replace("__META__", dumps(meta))
    out_path = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)

    lens = {}
    spread = {0: 0, 1: 0, 2: 0, 3: 0}
    for q in questions:
        lens[len(q["opts"])] = lens.get(len(q["opts"]), 0) + 1
        if q["ans"] < 4:
            spread[q["ans"]] += 1
    print("题目 %d 道" % len(questions))
    print("选项数分布: " + ", ".join("%d 项 × %d" % (k, v) for k, v in sorted(lens.items())))
    print("答案分布(仅 4 选项): A%d B%d C%d D%d" % (spread[0], spread[1], spread[2], spread[3]))
    print("写出 %s（%.1f KB）" % (out_path, os.path.getsize(out_path) / 1024.0))


if __name__ == "__main__":
    main()
