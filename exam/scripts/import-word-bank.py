#!/usr/bin/env python3
import json
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

WORD_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def extract_paragraphs(docx_path):
    with zipfile.ZipFile(docx_path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    paragraphs = []
    for paragraph in root.iter(WORD_NS + "p"):
        text = "".join(node.text or "" for node in paragraph.iter(WORD_NS + "t"))
        text = " ".join(text.split())
        if text:
            paragraphs.append(text)
    return paragraphs


def section(paragraphs, start_prefix, end_prefix=None):
    start = next(index for index, text in enumerate(paragraphs) if text.startswith(start_prefix)) + 1
    end = len(paragraphs)
    if end_prefix:
        end = next(index for index, text in enumerate(paragraphs[start:], start) if text.startswith(end_prefix))
    return paragraphs[start:end]


def parse_choice(text, kind, index):
    answer_match = re.search(r"答案[:：]\s*([A-D]+)\s*$", text)
    if not answer_match:
        return None
    answer = list(answer_match.group(1))
    body = text[:answer_match.start()].strip()
    first_option = re.search(r"\sA[.．、]\s*", body)
    if not first_option:
        return None
    prompt = body[:first_option.start()].strip()
    options_text = body[first_option.start():]
    options = []
    matches = list(re.finditer(r"(?:^|\s)([A-D])[.．、]\s*", options_text))
    for option_index, match in enumerate(matches):
        value_start = match.end()
        value_end = matches[option_index + 1].start() if option_index + 1 < len(matches) else len(options_text)
        options.append({"key": match.group(1), "text": options_text[value_start:value_end].strip()})
    if len(options) < 2:
        return None
    return {
        "id": f"{kind}-{index:02d}",
        "type": kind,
        "prompt": prompt,
        "options": options,
        "answer": answer,
        "points": 2 if kind == "single" else 3,
    }


def parse_fill(text, index):
    match = re.search(r"答案[:：]\s*(.+)$", text)
    if not match:
        return None
    raw_answer = match.group(1).strip()
    prompt = text[:match.start()].strip()
    answers = [part.strip() for part in re.split(r"\s*/\s*|、", raw_answer) if part.strip()]
    return {
        "id": f"fill-{index:02d}",
        "type": "fill",
        "prompt": prompt,
        "acceptedAnswers": answers,
        "answer": raw_answer,
        "points": 2,
    }


def parse_qa(text):
    match = re.match(r"(.+?)\s*答[:：]\s*(.+)$", text)
    if not match:
        return None
    return match.group(1).strip(), match.group(2).strip()


def grading_criteria(answer):
    answer = answer.strip()
    return answer if len(answer) >= 4 else f"正确答案：{answer}"


def parse_formal_choice(text, index, category):
    answer_match = re.search(r"参考答案[:：]\s*([A-D]+)\s*$", text)
    if not answer_match:
        return None
    body = text[:answer_match.start()].strip()
    option_matches = list(re.finditer(r"([A-D])[.．、]\s*", body))
    if len(option_matches) < 2 or option_matches[0].group(1) != "A":
        return None
    prompt = body[:option_matches[0].start()].strip()
    options = []
    for option_index, match in enumerate(option_matches):
        value_end = option_matches[option_index + 1].start() if option_index + 1 < len(option_matches) else len(body)
        options.append({"key": match.group(1), "text": body[match.end():value_end].strip()})
    answer = list(answer_match.group(1))
    # These two answer letters conflict with the rules stated elsewhere in the same document.
    answer_overrides = {
        "接单后最晚多久内回复老板？": ["C"],
        "老板中途暂停且未告知重启时间，陪玩等待多久后可自行撤离？": ["B"],
    }
    answer = answer_overrides.get(prompt, answer)
    kind = "single" if len(answer) == 1 else "multiple"
    return {
        "id": f"{kind}-{index:03d}",
        "type": kind,
        "prompt": prompt,
        "options": options,
        "answer": answer,
        "points": 2 if kind == "single" else 3,
        "category": category,
    }


def parse_formal_judge(text, index, category):
    match = re.search(r"答案[:：]\s*(对|错)(?:[（(](.*)[）)])?\s*$", text)
    if not match:
        return None
    prompt = text[:match.start()].strip()
    if not prompt:
        return None
    return {
        "id": f"judge-{index:03d}",
        "type": "judge",
        "prompt": prompt,
        "answer": "true" if match.group(1) == "对" else "false",
        "explanation": (match.group(2) or "").strip(),
        "points": 2,
        "category": category,
    }


def parse_checklist_question(text, index):
    match = re.match(r"^-\s*\[\s*\]\s*\d+[、.]\s*(.+)$", text)
    if not match:
        return None
    body = match.group(1).strip()
    answer_parts = [part.strip() for part in re.findall(r"[（(]([^）)]*)[）)]", body) if part.strip()]
    prompt = re.sub(r"[（(][^）)]*[）)]", "", body).strip()
    if not answer_parts:
        split_at = max(body.rfind("（"), body.rfind("("))
        if split_at > 0:
            prompt = body[:split_at].strip()
            answer_parts = [body[split_at + 1:].rstrip("）)").strip()]
    criteria = "；".join(answer_parts)
    if not prompt or not criteria:
        return None
    return {
        "id": f"short-{index:03d}",
        "type": "short",
        "prompt": prompt,
        "gradingCriteria": grading_criteria(criteria),
        "points": 5,
        "category": "补充考核题",
    }


def build_structured_bank(paragraphs, source_name):
    questions = []
    counts = {"single": 0, "multiple": 0, "judge": 0, "short": 0, "scenario": 0}
    current_part = ""
    current_section = ""
    formal_parts = {"接单与订单", "服务沟通与红线", "护航与售后", "规章制度与处罚"}

    for text in paragraphs:
        part_match = re.match(r"^第[一二三四五六七八九十]+部分[　\s]*(.+)$", text)
        if part_match:
            current_part = part_match.group(1).strip()
            current_section = ""
            continue
        section_match = re.match(r"^[一二三四五六七八九十]+、(.+)$", text)
        if section_match:
            current_section = section_match.group(1).strip()
            continue
        category = " / ".join(part for part in (current_part, current_section) if part)

        if current_part == "客观知识问答" and text.startswith("问："):
            parsed = parse_qa(text)
            if parsed:
                counts["short"] += 1
                prompt, answer = parsed
                questions.append({
                    "id": f"short-{counts['short']:03d}",
                    "type": "short",
                    "prompt": prompt,
                    "gradingCriteria": grading_criteria(answer),
                    "points": 5,
                    "category": category,
                })
            continue

        if current_part == "实战情景题" and text.startswith("情景："):
            parsed = parse_qa(text)
            if parsed:
                counts["scenario"] += 1
                prompt, answer = parsed
                questions.append({
                    "id": f"scenario-{counts['scenario']:03d}",
                    "type": "scenario",
                    "prompt": prompt,
                    "gradingCriteria": grading_criteria(answer),
                    "points": 9,
                    "category": category,
                })
            continue

        if current_part in formal_parts and "参考答案" in text:
            next_index = counts["single"] + counts["multiple"] + 1
            parsed = parse_formal_choice(text, next_index, current_part)
            if parsed:
                counts[parsed["type"]] += 1
                questions.append(parsed)
            continue

        if current_part in formal_parts and "答案" in text:
            parsed = parse_formal_judge(text, counts["judge"] + 1, current_part)
            if parsed:
                counts["judge"] += 1
                questions.append(parsed)
            continue

        if text.startswith("- [ ]"):
            parsed = parse_checklist_question(text, counts["short"] + 1)
            if parsed:
                counts["short"] += 1
                questions.append(parsed)

    return {
        "sourceDocument": source_name,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "recommendedBlueprint": {
            "single": 15,
            "multiple": 0,
            "fill": 0,
            "judge": 6,
            "short": 6,
            "scenario": 3,
        },
        "questions": questions,
    }


def judge_questions():
    rows = [
        ("娱乐陪接受技术类投诉。", False, "店铺所有娱乐陪不接受技术类投诉。"),
        ("受 APP 机制限制，进度单无法中途暂停或转单。", True, "除小时单可按实际时长结单外，进度单无法中途暂停或转单。"),
        ("私下转账形成的私单出现问题，由店铺承担售后责任。", False, "任何形式的私单出现问题，店铺概不负责。"),
        ("护航单默认双护，接单时每人至少准备 6 张卡。", True, "护航单默认双护，每人至少 6 张卡并带齐红卡金卡。"),
        ("老板未提前沟通私自带红弹导致炸单，仍需正常补保底。", False, "未提前沟通私自塞红弹，炸单不加保底。"),
        ("打手私藏物资时，对应订单可以直接免单。", True, "打手私藏物资，对应订单直接免单。"),
        ("接单期间因设备问题让老板等待超过 10 分钟，只需口头道歉。", False, "对应处罚为免单，并处 50 元起递增罚款。"),
        ("接单必须全程录屏，且录屏应包含完整画面和全部语音。", True, "无有效录屏产生客诉时，由陪玩承担全部责任。"),
        ("三角洲普通段位允许在接待大厅临时组队接单。", False, "普通段位严禁临时组队，魔王以上段位不限制。"),
        ("技术陪向下兼容低价单后，老板预存费用可在后续涨价。", False, "预存订单永久按原单价结算，不得后续抬价。"),
        ("时长单结束前 10 分钟，应提醒老板剩余时间，但不得主动诱导续费。", True, "只能礼貌提醒时间，由老板自行决定是否续单。"),
        ("被投诉后，陪玩可以私加老板微信解释并请求撤诉。", False, "严禁私下联系老板解释或求情。"),
        ("老板中途离开且未说明返回时间，陪玩应原地等待 10 分钟。", True, "等待 10 分钟后才可正常离场，并可预约后续开局时间。"),
        ("陪玩自身本局游戏收益可以高于老板收益。", False, "三角洲护航对局中，陪玩自身收益不得高于老板。"),
        ("工资应以平台猫粮形式自行提现至银行卡。", True, "工资以平台猫粮形式提现，切勿兑换钻石。"),
        ("在接单群和通告群内闲聊顶消息，单次罚款 10 元。", True, "群内闲聊顶消息单次罚款 10 元。"),
        ("进群后不按格式修改昵称，不会受到处罚。", False, "进群未按格式改群昵称，罚款 10 元。"),
        ("混单、挂机、不认真游戏、明显划水的罚款标准为 500 元。", True, "相关行为处罚为罚款 500 元。"),
    ]
    return [
        {
            "id": f"judge-{index:02d}",
            "type": "judge",
            "prompt": prompt,
            "answer": "true" if answer else "false",
            "explanation": explanation,
            "points": 2,
        }
        for index, (prompt, answer, explanation) in enumerate(rows, 1)
    ]


def build_bank(paragraphs, source_name):
    if any(text.startswith("第三部分") for text in paragraphs) and any("参考答案" in text for text in paragraphs):
        return build_structured_bank(paragraphs, source_name)
    questions = []

    single_rows = section(paragraphs, "一、单项选择题", "二、多项选择题")
    for text in single_rows:
        parsed = parse_choice(text, "single", len([q for q in questions if q["type"] == "single"]) + 1)
        if parsed:
            questions.append(parsed)

    multiple_rows = section(paragraphs, "二、多项选择题", "三、填空题")
    multiple_count = 0
    for text in multiple_rows:
        parsed = parse_choice(text, "multiple", multiple_count + 1)
        if parsed:
            questions.append(parsed)
            multiple_count += 1

    fill_rows = section(paragraphs, "三、填空题", "四、简答题")
    fill_count = 0
    for text in fill_rows:
        parsed = parse_fill(text, fill_count + 1)
        if parsed:
            questions.append(parsed)
            fill_count += 1

    short_rows = section(paragraphs, "四、简答题", "五、情境演绎题")
    short_count = 0
    for text in short_rows:
        parsed = parse_qa(text)
        if parsed:
            short_count += 1
            prompt, answer = parsed
            questions.append({
                "id": f"short-{short_count:02d}",
                "type": "short",
                "prompt": prompt,
                "referenceAnswer": answer,
                "points": 5,
            })

    scenario_count = 0
    for text in paragraphs:
        if text.startswith("情景：") and "答：" in text:
            parsed = parse_qa(text)
            if parsed:
                scenario_count += 1
                prompt, answer = parsed
                questions.append({
                    "id": f"scenario-{scenario_count:02d}",
                    "type": "scenario",
                    "prompt": prompt,
                    "referenceAnswer": answer,
                    "points": 9,
                })

    formal_rows = section(paragraphs, "五、情境演绎题")
    for index, text in enumerate(formal_rows):
        if not text.startswith("情境："):
            continue
        answer = next((row.removeprefix("参考答案：").strip() for row in formal_rows[index + 1:] if row.startswith("参考答案：")), None)
        if answer:
            scenario_count += 1
            questions.append({
                "id": f"scenario-{scenario_count:02d}",
                "type": "scenario",
                "prompt": text,
                "referenceAnswer": answer,
                "points": 9,
            })

    questions.extend(judge_questions())
    return {
        "sourceDocument": source_name,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "questions": questions,
    }


def main():
    if len(sys.argv) != 3:
        raise SystemExit("用法: import-word-bank.py <题库.docx> <输出.json>")
    source = Path(sys.argv[1])
    output = Path(sys.argv[2])
    paragraphs = extract_paragraphs(source)
    bank = build_bank(paragraphs, source.name)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(bank, ensure_ascii=False, indent=2), encoding="utf-8")
    counts = {}
    for question in bank["questions"]:
        counts[question["type"]] = counts.get(question["type"], 0) + 1
    print(f"已生成 {output}：{counts}")


if __name__ == "__main__":
    main()
