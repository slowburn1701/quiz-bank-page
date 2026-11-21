# 题库提取指南

目标：从原始题库稳定拿到 `questions.json`，且每道题的题干、选项、答案都能回原文核对。
原则：**宁缺毋滥**。无法确定答案的题单独列给用户，不要猜；不要改写题意。

## 通用套路

1. 先看文件结构：题号怎么标、选项怎么标（`A.` `A、` `（A）`）、答案写在哪（题干末尾、选项后、卷末答案表）。
2. 写一个小解析脚本，打印「识别到的题数 / 选项数分布 / 答案分布」，和文件肉眼数量对一遍。
3. 逐题检查首尾 3 题与随机中间 3 题，确认没有串行、粘连、漏项。
4. 只修明显的 OCR 错字；存疑的题列清单问用户。

## docx（最常用）

用 `python-docx` 按段落读，不要按表格——很多题库是“一段题干 + 四段选项”：

```python
import re
from docx import Document

paras = [p.text.strip() for p in Document(src).paragraphs if p.text.strip()]
```

常见排版与处理：

- 题干行以题号开头：`^\s*(\d{1,3})\s*[.、．)]\s*`
- 选项行：`^\s*([A-DＡ-Ｄ])\s*[.、．)）]\s*`
- 答案可能是：题干末尾单独的 `A`；`（A）`；`答案：A`；或卷末「1-5 ABCDA」。
- **粘连**：上一题的 D 选项和下一题题干在同一段，例如 `D. …… 14. 下一题……`。
  在题号前补换行再切分：`re.sub(r'(?<=[^\n\d])(?=\s*\d{1,3}\s*[.、．]\s*[\u4e00-\u9fff“"‘])', '\n', text)`
- **缺题号**：连续段落里出现「选项 A–D 齐了却没有题号」的题干，按顺序补号，并记下来核对总数。

## xlsx

`openpyxl` 读第一个工作表，先打印前 5 行确认表头，再按列映射：

```python
from openpyxl import load_workbook
ws = load_workbook(src, read_only=True, data_only=True).worksheets[0]
for row in ws.iter_rows(values_only=True):
    ...
```

注意合并单元格（题干跨行）、答案列是字母还是数字、是否有“正确答案”整列缺失需要回填。

## PDF / 扫描件

- 文本型 PDF：`pdftotext -layout in.pdf out.txt`（保留列对齐）；没有 poppler 时用 PyMuPDF（`fitz`）逐页 `get_text()`。
- 双栏排版：先按栏切再按行合并，否则题号会跳。
- 扫描/拍照：走 OCR（vision 工具或本机 OCR），**OCR 结果必须人工校对**，尤其选项字母与答案字母。
- OCR 或 PDF 抽取质量差时，直接让用户提供 docx/txt 版本，比硬啃更省时间。

## txt / md

直接按行解析；md 常见 `1. 题干` + `- A. 选项` + `答案：B`。注意列表符号与缩进。

## 答案与选项的校验脚本

```python
import collections, re
lens = collections.Counter(len(q["opts"]) for q in qs)
ans = collections.Counter(q["ans"] for q in qs)
print(len(qs), lens, ans)
stems = [q["q"] for q in qs]
dup = [s for s, c in collections.Counter(stems).items() if c > 1]
print("duplicate stems:", dup)
```

- 题数对不上：先查题号重复/回绕、题干与选项粘连、跨页断行。
- 答案全是同一个字母：解析错位，别继续。
- 选项数忽多忽少：多选或「以上都是」被拆错，逐题看。

## 判断题

`["正确", "错误"]` 两个选项即可，`ans` 0/1。不要为了凑四选项编造干扰项。

## 多选题

当前引擎是单选判分，**不支持一题多个正确项**。处理方式：

1. 优先建议用户把多选题拆成多道单选（例如“以下哪项属于……”）；
2. 或把多选题改成“选出错误项”等单选形式，但要用户确认题意等价；
3. 都不行就排除这些题，并在交付说明里写明排除了哪几题、为什么。

不要偷偷只保留一个正确项当单选——那会教错。
