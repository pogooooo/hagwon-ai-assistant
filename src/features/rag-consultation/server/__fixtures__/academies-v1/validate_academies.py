"""가상 학원 RAG 테스트 자료(academies-v1) 형식·참조·사실↔원문 일치 검사.

RAG 정확도 시험이 아니라 테스트 입력의 무결성 검사다.
사용: python3 -I validate_academies.py [ACADEMY_ID ...]
"""
from pathlib import Path
import datetime
import json
import re
import sys

ROOT = Path(__file__).resolve().parent
DOC_TYPES = {"academy_info", "fee", "schedule", "policy", "facility", "teacher", "announcement", "student_analysis", "guidance"}
VISIBILITY = {"academy_public", "class_members", "student_private", "staff_only"}
ROLES = {"visitor", "student", "guardian", "teacher", "admin"}
STATUSES = {"answered", "partial", "abstained", "clarify", "denied", "handoff"}
FACT_KINDS = {
    "monthly_fee": "money", "material_fee": "money", "schedule": "schedule", "teacher": "text",
    "enrollment_status": "enrollment", "schedule_change": "schedule_change", "makeup_policy": "text",
    "facility": "text", "accuracy": "accuracy", "weak_area": "weak_area", "learning_guidance": "text",
    "notice": "text",
}
ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
STUDENT_ID = re.compile(r"^[A-Z]{2}_STU_\d{3}$")


def compact(text):
    return re.sub(r"\s+", "", text or "")


def parse_front_matter(path):
    raw = path.read_text(encoding="utf-8")
    if not raw.startswith("---\n"):
        raise ValueError("front matter 없음")
    end = raw.index("\n---\n", 4)
    meta = {}
    for line in raw[4:end].splitlines():
        if not line.strip() or line.strip().startswith("#"):
            continue
        key, _, value = line.partition(":")
        value = value.strip()
        if " #" in value:
            value = value.split(" #", 1)[0].strip()
        if value in ("", "null", "~"):
            meta[key.strip()] = None
            continue
        try:
            meta[key.strip()] = json.loads(value)
        except json.JSONDecodeError:
            meta[key.strip()] = value
    return meta, raw[end + 5:]


def parse_time(value):
    return datetime.datetime.fromisoformat(value) if value else None


def load_jsonl(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def money_forms(amount):
    forms = {f"{amount:,}", str(amount)}
    return forms


def validate_academy(directory, errors):
    def ck(condition, message):
        if not condition:
            errors.append(f"[{directory.name}] {message}")

    academy = json.loads((directory / "academy.json").read_text(encoding="utf-8"))
    users = json.loads((directory / "users.json").read_text(encoding="utf-8"))
    students = json.loads((directory / "students.json").read_text(encoding="utf-8"))
    academy_id = academy["academy_id"]
    ck(academy_id == directory.name, "폴더명과 academy_id 불일치")
    class_ids = {c["class_id"] for c in academy["classes"]}
    ck(len(class_ids) == len(academy["classes"]), "중복 class_id")
    for c in academy["classes"]:
        ck(ID.match(c["class_id"]) is not None, f"class_id 형식 {c['class_id']}")
        ck(bool(c.get("name")), f"반 이름 없음 {c['class_id']}")

    student_ids = set()
    alias_owner = {}
    for s in students:
        ck(STUDENT_ID.match(s["student_id"]) is not None, f"student_id 형식 {s['student_id']}")
        ck(s["academy_id"] == academy_id, f"학생 학원 불일치 {s['student_id']}")
        ck(s["student_id"] not in student_ids, f"중복 학생 {s['student_id']}")
        student_ids.add(s["student_id"])
        for c in s.get("class_ids", []):
            ck(c in class_ids, f"학생 반 없음 {s['student_id']} {c}")
        for alias in [s["name"], *s.get("aliases", [])]:
            ck(alias not in alias_owner or alias_owner[alias] == s["student_id"], f"학생 별칭 중복 {alias}")
            alias_owner[alias] = s["student_id"]

    user_by_id = {}
    for u in users:
        ck(u["role"] in ROLES, f"role {u['user_id']}")
        ck(u["academy_id"] == academy_id, f"계정 학원 불일치 {u['user_id']}")
        ck(u["user_id"] not in user_by_id, f"중복 계정 {u['user_id']}")
        user_by_id[u["user_id"]] = u
        for sid in u["allowed_student_ids"]:
            ck(sid in student_ids, f"계정 허용 학생 없음 {u['user_id']} {sid}")
        for cid in u["allowed_class_ids"]:
            ck(cid in class_ids, f"계정 허용 반 없음 {u['user_id']} {cid}")
        if u["role"] == "visitor":
            ck(not u["allowed_student_ids"], f"방문자에게 학생 권한 {u['user_id']}")
        for sid in (u.get("student_aliases") or {}):
            ck(sid in u["allowed_student_ids"], f"허용되지 않은 학생 별칭 {u['user_id']} {sid}")

    documents = {}
    for path in sorted((directory / "documents").glob("*.md")):
        try:
            meta, body = parse_front_matter(path)
        except Exception as exc:  # noqa: BLE001
            ck(False, f"{path.name}: {exc}")
            continue
        key = (meta.get("document_id"), meta.get("revision"))
        ck(path.name == f"{key[0]}__r{key[1]}.md", f"파일명 규칙 {path.name}")
        ck(key not in documents, f"중복 문서 {key}")
        ck(ID.match(str(key[0])) is not None, f"document_id 형식 {path.name}")
        ck(isinstance(key[1], int) and key[1] >= 1, f"revision {path.name}")
        ck(meta.get("document_type") in DOC_TYPES, f"document_type {path.name}")
        ck(meta.get("status") in ("approved_active", "draft"), f"status {path.name}")
        ck(meta.get("visibility") in VISIBILITY, f"visibility {path.name}")
        ck(bool(meta.get("title")), f"title {path.name}")
        ck(len(body.strip()) > 0, f"본문 없음 {path.name}")
        if meta.get("class_id") is not None:
            ck(meta["class_id"] in class_ids, f"문서 반 없음 {path.name}")
        if meta.get("document_type") == "student_analysis" or meta.get("visibility") == "student_private":
            ck(meta.get("student_id") in student_ids, f"리포트 학생 없음 {path.name}")
            ck(meta.get("visibility") == "student_private", f"리포트 공개 범위 {path.name}")
        try:
            start, end = parse_time(meta.get("valid_from")), parse_time(meta.get("valid_to"))
            ck(start is not None and start.tzinfo is not None, f"valid_from {path.name}")
            if end is not None:
                ck(end > start, f"유효 기간 순서 {path.name}")
        except Exception:  # noqa: BLE001
            ck(False, f"시간 형식 {path.name}")
        meta["_body"] = body
        documents[key] = meta

    facts = load_jsonl(directory / "facts.jsonl")
    fact_by_id = {}
    for f in facts:
        fid = f.get("fact_id")
        ck(ID.match(str(fid)) is not None, f"fact_id 형식 {fid}")
        ck(fid not in fact_by_id, f"중복 사실 {fid}")
        fact_by_id[fid] = f
        doc = documents.get((f.get("document_id"), f.get("revision")))
        ck(doc is not None, f"사실의 문서 없음 {fid}")
        if doc is None:
            continue
        ck(doc.get("status") == "approved_active", f"미승인 문서의 사실 {fid}")
        ck(f.get("academy_id") == academy_id, f"사실 학원 {fid}")
        expected_kind = FACT_KINDS.get(f.get("fact_type"))
        ck(expected_kind is not None, f"fact_type {fid}")
        value = f.get("value") or {}
        ck(value.get("kind") == expected_kind, f"value.kind {fid}")
        body = doc["_body"]
        cbody = compact(body)
        subject_type = f.get("subject_type")
        if subject_type == "student":
            ck(f.get("subject_id") == doc.get("student_id"), f"학생 사실 귀속 {fid}")
            ck(re.match(r"^\d{4}-\d{2}$", f.get("period") or "") is not None, f"학생 사실 period {fid}")
            for a in f.get("assignments") or []:
                ck(bool(a.get("assignment_id")) and bool(a.get("title")), f"assignments 형식 {fid}")
                ck(compact(a.get("title")) in cbody, f"숙제 제목이 원문에 없음 {fid}")
        elif subject_type == "class":
            ck(f.get("subject_id") in class_ids, f"사실 반 없음 {fid}")
        elif subject_type == "academy":
            ck(f.get("subject_id") == academy_id, f"학원 사실 subject {fid}")
        else:
            ck(False, f"subject_type {fid}")
        try:
            fs, fe = parse_time(f.get("valid_from")), parse_time(f.get("valid_to"))
            ds, de = parse_time(doc.get("valid_from")), parse_time(doc.get("valid_to"))
            ck(fs >= ds, f"사실 유효 시작이 문서보다 이름 {fid}")
            if de is not None:
                ck(fe is not None and fe <= de, f"사실 유효 종료가 문서 밖 {fid}")
        except Exception:  # noqa: BLE001
            ck(False, f"사실 시간 형식 {fid}")

        kind = value.get("kind")
        if kind == "money":
            ck(any(form in body for form in money_forms(value.get("amount", -1))), f"금액이 원문에 없음 {fid} {value.get('amount')}")
        elif kind in ("text", "schedule"):
            ck(compact(value.get("text")) in cbody, f"text 가 원문에 없음 {fid}")
        elif kind == "enrollment":
            ck(value.get("status") in ("open", "waitlist", "closed"), f"enrollment status {fid}")
            ck(compact(value.get("text")) in cbody, f"enrollment text 가 원문에 없음 {fid}")
        elif kind == "schedule_change":
            ck(value.get("change_type") in ("cancel", "makeup"), f"change_type {fid}")
            y, m, d = (int(x) for x in value.get("date", "0-0-0").split("-"))
            ck(f"{m}월{d}일" in cbody or value.get("date") in body, f"휴보강 날짜가 원문에 없음 {fid}")
            ck(compact(value.get("text")) in cbody, f"휴보강 text 가 원문에 없음 {fid}")
        elif kind == "accuracy":
            correct, total = value.get("correct"), value.get("total")
            ck(isinstance(correct, int) and isinstance(total, int) and 0 <= correct <= total and total > 0, f"정답률 범위 {fid}")
            ck(value.get("dimension") in ("unit", "question_type", "overall"), f"dimension {fid}")
            label = value.get("unit")
            if value.get("dimension") == "unit":
                ck(label in academy.get("units", []), f"academy.units 에 없는 단원 {fid} {label}")
            if value.get("dimension") == "question_type":
                ck(label in academy.get("question_types", []), f"academy.question_types 에 없는 유형 {fid} {label}")
            pattern_c = re.compile(rf"(?<!\d){correct}(?!\d)")
            pattern_t = re.compile(rf"(?<!\d){total}(?!\d)")
            ck(any(pattern_c.search(line) and pattern_t.search(line) and (label == "전체" or compact(label) in compact(line))
                   for line in body.splitlines()), f"정답 수·문항 수·이름이 원문 같은 줄에 없음 {fid}")
        elif kind == "weak_area":
            ck(compact(value.get("unit")) in cbody and compact(value.get("text")) in cbody, f"취약 영역이 원문에 없음 {fid}")

    for f in facts:
        doc = documents.get((f.get("document_id"), f.get("revision")))
        if doc is not None:
            f["_source_id"] = f"{f['document_id']}:r{f['revision']}:body"

    source_ids = {f"{k[0]}:r{k[1]}:body" for k, d in documents.items() if d.get("status") == "approved_active"}
    cases = load_jsonl(directory / "cases.jsonl")
    seen = set()
    for c in cases:
        cid = c.get("case_id")
        ck(cid not in seen, f"중복 case {cid}")
        seen.add(cid)
        inp, exp = c.get("input", {}), c.get("expected", {})
        user = user_by_id.get(inp.get("user_id"))
        ck(user is not None, f"case 계정 없음 {cid}")
        ck(exp.get("status") in STATUSES, f"case status {cid}")
        ck(exp.get("generation_budget_max") in (0, 1), f"generation_budget_max {cid}")
        ck(inp.get("api_state") in ("ok", "429", "5xx", "timeout", "quota_exhausted"), f"api_state {cid}")
        ck(c.get("split") in ("dev", "holdout"), f"split {cid}")
        try:
            ck(parse_time(inp.get("as_of")).tzinfo is not None, f"as_of {cid}")
        except Exception:  # noqa: BLE001
            ck(False, f"as_of 형식 {cid}")
        for key in ("must_include", "must_not_include"):
            ck(isinstance(exp.get(key, []), list), f"{key} 형식 {cid}")
        for fid in exp.get("fact_ids", []):
            f = fact_by_id.get(fid)
            ck(f is not None, f"case 사실 없음 {cid} {fid}")
            if f and user and f.get("subject_type") == "student":
                ck(f["subject_id"] in user["allowed_student_ids"], f"권한 밖 학생 사실을 정답으로 사용 {cid} {fid}")
        for sid in exp.get("source_ids", []):
            ck(sid in source_ids, f"case 출처 없음/미승인 {cid} {sid}")
        if exp.get("status") in ("abstained", "clarify", "denied", "handoff"):
            ck(not exp.get("fact_ids") and not exp.get("source_ids"), f"보류·거부 사례에 근거가 지정됨 {cid}")
        session = inp.get("session") or {}
        for key in session:
            ck(key in ("selected_student_id", "candidate_student_ids", "selected_period"), f"session 키 {cid} {key}")

    return {"documents": len(documents), "facts": len(facts), "cases": len(cases), "students": len(students), "users": len(users)}


def main():
    targets = sys.argv[1:] or sorted(p.name for p in ROOT.iterdir() if p.is_dir() and (p / "academy.json").exists())
    errors = []
    for name in targets:
        stats = validate_academy(ROOT / name, errors)
        print(f"{name}: {stats}")
    print("validation:", "PASS" if not errors else "FAILED", len(errors), "errors")
    for message in errors[:80]:
        print(" -", message)
    sys.exit(0 if not errors else 1)


if __name__ == "__main__":
    main()
