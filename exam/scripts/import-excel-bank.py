#!/usr/bin/env python3
"""Import the question and exam configuration sheets using Python's standard library."""
import json
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
TYPES = {"判断题": "judge", "单选题": "single", "多选题": "multiple"}


def read_sheets(source):
    with zipfile.ZipFile(source) as archive:
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            strings = ["".join(node.text or "" for node in item.findall(".//s:t", NS)) for item in root.findall("s:si", NS)]
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {item.attrib["Id"]: item.attrib["Target"] for item in relationships}
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        sheets = {}
        for sheet in workbook.findall("s:sheets/s:sheet", NS):
            target = targets[sheet.attrib[f"{{{REL_NS}}}id"]]
            target = target.lstrip("/") if target.startswith("/") else f"xl/{target}"
            root = ET.fromstring(archive.read(target))
            rows = []
            for row in root.findall("s:sheetData/s:row", NS):
                cells = {}
                for cell in row.findall("s:c", NS):
                    column = re.match(r"[A-Z]+", cell.attrib["r"])[0]
                    value = cell.find("s:v", NS)
                    kind = cell.attrib.get("t")
                    if kind == "inlineStr":
                        text = "".join(node.text or "" for node in cell.findall("s:is//s:t", NS))
                    elif kind == "s" and value is not None:
                        text = strings[int(value.text)]
                    else:
                        text = value.text if value is not None else ""
                    cells[column] = text.strip()
                if any(cells.values()):
                    rows.append(cells)
            sheets[sheet.attrib["name"]] = rows
        return sheets


def number(value):
    match = re.search(r"\d+", value)
    if not match:
        raise ValueError(f"配置缺少数字：{value}")
    return int(match[0])


def build_bank(source):
    sheets = read_sheets(source)
    settings = {row["A"]: row for row in sheets["考试配置"][2:]}
    blueprint = dict.fromkeys(["single", "multiple", "fill", "judge", "short", "scenario"], 0)
    for label, count in re.findall(r"(判断题|单选题|多选题)\s*(\d+)", settings["题目数量"]["C"]):
        blueprint[TYPES[label]] = int(count)
    questions = []
    for row in sheets["题目"][2:]:
        kind = TYPES[row["B"]]
        options = [{"key": key, "text": row.get(column, "")} for key, column in zip("ABCD", "EFGH") if row.get(column)]
        answer = list(row["I"].upper())
        keys = {option["key"] for option in options}
        if not row["D"] or not answer or not set(answer) <= keys:
            raise ValueError(f"第 {row['A']} 题题干或答案无效")
        if kind == "single" and len(answer) != 1:
            raise ValueError(f"第 {row['A']} 题单选答案数量错误")
        if kind == "judge":
            if len(answer) != 1 or row["I"] not in {"A", "B"} or [option["text"] for option in options] != ["对", "错"]:
                raise ValueError(f"第 {row['A']} 题判断答案格式错误")
            answer = "true" if row["I"] == "A" else "false"
        questions.append({
            "id": f"jqcn-{int(row['A']):02d}", "type": kind, "prompt": row["D"],
            "points": int(row["C"]), "answer": answer,
            "explanation": row.get("J", ""), "category": row.get("K", ""),
            "source": row.get("K", ""), "enabled": True,
            **({"options": options} if kind != "judge" else {}),
        })
    if len({question["id"] for question in questions}) != len(questions):
        raise ValueError("题目序号重复")
    counts = Counter(question["type"] for question in questions)
    if len(questions) != number(settings["题目数量"]["B"]) or any(counts[kind] != count for kind, count in blueprint.items()):
        raise ValueError("题库数量与考试配置不一致")
    total_score = number(settings["总分"]["B"])
    if sum(question["points"] for question in questions) != total_score or total_score != 100:
        raise ValueError("题库分值与满分 100 分不一致")
    if "取最高分" not in settings["作答次数"]["C"] or "多选全对才得分" != settings["题型计分"]["B"]:
        raise ValueError("不支持的成绩或多选计分配置")
    return {
        "sourceDocument": source.name,
        "examConfig": {
            "clubName": "机枪纯女电竞", "examTitle": "俱乐部入职文考",
            "examMinutes": number(settings["考试时长"]["B"]),
            "passScore": number(settings["通过线"]["B"]),
            "maxAttempts": number(settings["作答次数"]["B"]),
            "scorePolicy": "highest", "totalScore": total_score,
            "multipleChoiceScoring": "all-or-nothing", "blueprint": blueprint,
        },
        "questions": questions,
    }


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("用法：import-excel-bank.py <题库.xlsx> <输出.json>")
    bank = build_bank(Path(sys.argv[1]))
    output = Path(sys.argv[2])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(bank, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Imported {len(bank['questions'])} questions; {bank['examConfig']['examMinutes']} minutes; 100 points.")
