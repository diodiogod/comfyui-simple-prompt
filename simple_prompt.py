from __future__ import annotations

import hashlib
import difflib
import json
import os
import re
import shutil
import threading
import time
from typing import Any, Dict, List, Optional

try:
    from rapidfuzz import fuzz
    _HAS_RAPIDFUZZ = True
except ImportError:
    fuzz = None
    _HAS_RAPIDFUZZ = False

try:
    from server import PromptServer
    from aiohttp import web
except Exception:
    PromptServer = None
    web = None


PG_ALWAYS_REROLL = True
_SCHEMA_VERSION = 1
_HIST_LOCK = threading.Lock()
_LINEAGE_LOCK = threading.Lock()
_LINEAGE_SESSIONS: Dict[tuple[str, str], Dict[str, str]] = {}


def _module_dir() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def _data_dir() -> str:
    path = os.path.join(_module_dir(), "data")
    os.makedirs(path, exist_ok=True)
    return path


def _default_history_path() -> str:
    return os.path.abspath(os.path.join(_data_dir(), "prompt_history.json"))


_DEFAULT_HISTORY_PATH = _default_history_path()


def _history_sources() -> List[str]:
    custom_nodes_dir = os.path.dirname(_module_dir())
    candidates = [
        os.path.join(custom_nodes_dir, "PG-Nodes", "data", "prompt_history.json"),
        os.path.join(custom_nodes_dir, "prompt_history.json"),
    ]
    out: List[str] = []
    for path in candidates:
        ap = os.path.abspath(path)
        if ap == _DEFAULT_HISTORY_PATH:
            continue
        if ap not in out:
            out.append(ap)
    return out


class HistoryStorageError(RuntimeError):
    pass


def _validate_history(data: Any, path: str) -> Dict[str, Any]:
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise HistoryStorageError(f"Invalid history structure in {path}")
    return data


def _read_history_file(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return _validate_history(json.load(f), path)


def _read_history(path: str) -> Dict[str, Any]:
    try:
        return _read_history_file(path)
    except FileNotFoundError:
        backup_path = path + ".bak"
        if os.path.isfile(backup_path):
            recovered = _read_history_file(backup_path)
            print(f"[Simple Prompt history] WARNING: {path} missing; recovered from {backup_path}")
            return recovered
        return {"schema": _SCHEMA_VERSION, "items": []}
    except Exception as ex:
        backup_path = path + ".bak"
        try:
            recovered = _read_history_file(backup_path)
            print(f"[Simple Prompt history] WARNING: {path} unreadable; recovered from {backup_path}: {ex}")
            return recovered
        except Exception as backup_ex:
            raise HistoryStorageError(
                f"History is unreadable and was not overwritten. Main error: {ex}; backup error: {backup_ex}"
            ) from ex


def _write_history_atomic(path: str, data: Dict[str, Any]) -> None:
    _validate_history(data, path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    backup_tmp = tmp + ".bak"

    def refresh_backup() -> None:
        with open(path, "rb") as src, open(backup_tmp, "wb") as dst:
            shutil.copyfileobj(src, dst)
            dst.flush()
            os.fsync(dst.fileno())
        os.replace(backup_tmp, path + ".bak")

    try:
        if os.path.isfile(path):
            try:
                _read_history_file(path)
                refresh_backup()
            except Exception:
                pass

        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        refresh_backup()
        try:
            dir_fd = os.open(os.path.dirname(path), os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except (AttributeError, OSError):
            pass
    finally:
        for temp_path in (tmp, backup_tmp):
            try:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
            except OSError:
                pass


def _canonical_core(entry: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "positive": str(entry.get("positive") or ""),
        "negative": str(entry.get("negative") or ""),
    }


def _compute_key_hash(core: Dict[str, Any]) -> str:
    payload = json.dumps(core, sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _find_by_hash(items: List[Dict[str, Any]], key_hash: str) -> int:
    for index, entry in enumerate(items):
        if entry.get("key_hash") == key_hash:
            return index
    return -1


def _make_history_record(
    key_hash: str,
    positive: str,
    negative: str,
    now: int,
    old_entry: Optional[Dict[str, Any]] = None,
    group_id: str = "",
    lineage_note: str = "",
) -> Dict[str, Any]:
    record = {
        "key_hash": key_hash,
        "positive": positive,
        "negative": negative,
        "created_at": now,
        "last_used_at": now,
        "hits": 1,
    }
    if old_entry:
        record["created_at"] = int(old_entry.get("created_at", now))
        record["hits"] = int(old_entry.get("hits", 0) or 0) + 1
        if old_entry.get("custom_name"):
            record["custom_name"] = old_entry["custom_name"]
        if old_entry.get("group_id"):
            record["group_id"] = old_entry["group_id"]
        if old_entry.get("lineage_note"):
            record["lineage_note"] = old_entry["lineage_note"]
    if group_id:
        record["group_id"] = group_id
    if lineage_note:
        record["lineage_note"] = lineage_note
    return record


def _merge_source_history() -> None:
    def load_items(path: str) -> List[Dict[str, Any]]:
        if not os.path.isfile(path):
            return []
        return [item for item in _read_history(path).get("items", []) if isinstance(item, dict)]

    merged_by_hash: Dict[str, Dict[str, Any]] = {}
    changed = False
    current_items = load_items(_DEFAULT_HISTORY_PATH)
    for item in current_items:
        kh = item.get("key_hash") or _compute_key_hash(_canonical_core(item))
        entry = dict(item)
        entry["key_hash"] = kh
        merged_by_hash[kh] = entry

    for source_path in _history_sources():
        for legacy in load_items(source_path):
            kh = legacy.get("key_hash") or _compute_key_hash(_canonical_core(legacy))
            existing = merged_by_hash.get(kh)
            if existing is None:
                merged = dict(legacy)
                merged["key_hash"] = kh
                merged_by_hash[kh] = merged
                changed = True
                continue

            existing_last = int(existing.get("last_used_at", 0) or 0)
            legacy_last = int(legacy.get("last_used_at", 0) or 0)
            merged = dict(legacy if legacy_last > existing_last else existing)
            merged["key_hash"] = kh
            created_values = [
                int(value)
                for value in (existing.get("created_at"), legacy.get("created_at"))
                if value and str(value).isdigit()
            ]
            if created_values:
                merged["created_at"] = min(created_values)
            merged["last_used_at"] = max(existing_last, legacy_last)
            merged["hits"] = max(
                int(existing.get("hits", 0) or 0),
                int(legacy.get("hits", 0) or 0),
                1,
            )
            if not merged.get("custom_name"):
                merged["custom_name"] = existing.get("custom_name") or legacy.get("custom_name") or ""
                if not merged["custom_name"]:
                    merged.pop("custom_name", None)
            if merged != existing:
                merged_by_hash[kh] = merged
                changed = True

    if changed or not os.path.isfile(_DEFAULT_HISTORY_PATH):
        merged_items = sorted(
            merged_by_hash.values(),
            key=lambda item: int(item.get("last_used_at", 0) or 0),
            reverse=True,
        )
        _write_history_atomic(_DEFAULT_HISTORY_PATH, {"schema": _SCHEMA_VERSION, "items": merged_items})
        print(f"[Simple Prompt history] Prepared standalone history with {len(merged_items)} entries")


def has_choice_syntax(text: str) -> bool:
    if not text:
        return False
    depth = 0
    has_bar = False
    for ch in str(text):
        if ch == "{":
            depth += 1
            has_bar = False
        elif ch == "|" and depth > 0:
            has_bar = True
        elif ch == "}":
            if depth > 0 and has_bar:
                return True
            depth = max(0, depth - 1)
            has_bar = False if depth == 0 else has_bar
    return False


def strip_prompt_comments(text: str) -> str:
    """Remove hash comments from output while preserving active lines."""
    return re.sub(r"[ \t]*#[^\r\n]*", "", text or "").strip()


def expand_choices(text: str, seed: Optional[int] = None) -> str:
    if not text or "{" not in text:
        return text or ""
    import random

    rng = random.Random(seed)
    chars = list(str(text))
    while True:
        stack: List[int] = []
        replaced = False
        i = 0
        while i < len(chars):
            ch = chars[i]
            if ch == "{":
                stack.append(i)
            elif ch == "}" and stack:
                start = stack.pop()
                segment = "".join(chars[start + 1 : i])
                if "|" in segment:
                    choice = rng.choice(segment.split("|"))
                    chars[start : i + 1] = list(choice)
                    replaced = True
                    break
            i += 1
        if not replaced:
            return "".join(chars)


def _meaningful_words(text: str) -> List[str]:
    import re

    return [
        word
        for word in re.findall(r"\w+", str(text or "").casefold(), flags=re.UNICODE)
        if len(word) >= 3
    ]


def _lineage_similarity(base_positive: str, positive: str) -> Dict[str, float]:
    """Measure how much ordered base content survives and how scattered edits are."""
    base_words = _meaningful_words(base_positive)
    current_words = _meaningful_words(positive)
    if not base_words or not current_words:
        return {"retained": 0.0, "weighted_retained": 0.0, "fragmentation": 1.0}

    matcher = difflib.SequenceMatcher(None, base_words, current_words, autojunk=False)
    opcodes = matcher.get_opcodes()
    matched_indexes = {
        index
        for tag, base_start, base_end, _, _ in opcodes
        if tag == "equal"
        for index in range(base_start, base_end)
    }

    # Prompt edges often contain reusable quality or camera tags. Content in the
    # middle carries more weight when deciding whether this is still a variation.
    def position_weight(index: int) -> float:
        position = (index + 0.5) / len(base_words)
        return 0.60 if position < 0.20 or position > 0.80 else 1.25

    total_weight = sum(position_weight(index) for index in range(len(base_words)))
    retained_weight = sum(position_weight(index) for index in matched_indexes)
    changed_regions = sum(1 for tag, *_ in opcodes if tag != "equal")
    possible_regions = max(1, (len(opcodes) + 1) // 2)
    return {
        "retained": len(matched_indexes) / len(base_words),
        "weighted_retained": retained_weight / total_weight,
        "fragmentation": changed_regions / possible_regions,
    }


def _continues_lineage(base_positive: str, positive: str) -> bool:
    """Continue behavioral lineage unless the selected prompt was broadly rewritten."""
    similarity = _lineage_similarity(base_positive, positive)
    weighted_retained = similarity["weighted_retained"]
    if weighted_retained >= 0.68:
        return True
    if weighted_retained < 0.42:
        return False
    return similarity["retained"] >= 0.50 and similarity["fragmentation"] <= 0.60


def _save_history_entry(
    positive: str,
    negative: str,
    history_group_id: str = "",
    history_base_key: str = "",
    history_base_positive: str = "",
) -> Dict[str, Any]:
    positive = "" if positive is None else str(positive)
    negative = "" if negative is None else str(negative)
    if not positive.strip() and not negative.strip():
        return {"saved": False, "reason": "empty"}

    core = {"positive": positive, "negative": negative}
    key_hash = _compute_key_hash(core)
    now = int(time.time())
    requested_group = str(history_group_id or "").strip()
    base_key = str(history_base_key or "").strip()
    lineage_attempted = bool(
        requested_group
        and base_key
        and key_hash != base_key
        and str(history_base_positive or "").strip()
    )
    similarity_continues = lineage_attempted and _continues_lineage(history_base_positive, positive)
    continue_group = bool(
        lineage_attempted
        and similarity_continues
    )

    with _HIST_LOCK:
        hist = _read_history(_DEFAULT_HISTORY_PATH)
        items = hist.get("items", [])
        if continue_group:
            base_idx = _find_by_hash(items, base_key)
            if base_idx >= 0:
                items[base_idx]["group_id"] = requested_group
            else:
                continue_group = False
        idx = _find_by_hash(items, key_hash)
        old_entry = items.pop(idx) if idx >= 0 else None
        group_id = requested_group if continue_group else ""
        lineage_note = "new_direction" if lineage_attempted and not similarity_continues and old_entry is None else ""
        items.insert(
            0,
            _make_history_record(
                key_hash,
                positive,
                negative,
                now,
                old_entry,
                group_id,
                lineage_note,
            ),
        )
        hist["schema"] = _SCHEMA_VERSION
        hist["items"] = items
        _write_history_atomic(_DEFAULT_HISTORY_PATH, hist)

    return {
        "saved": True,
        "key_hash": key_hash,
        "group_id": group_id or str((old_entry or {}).get("group_id") or ""),
        "lineage_continued": continue_group,
        "lineage_note": lineage_note,
        "total": len(items),
    }


def _parse_kh_prefix(value: str) -> str:
    if not value or value == "none":
        return ""
    return value.split(" ", 1)[0].split("—", 1)[0].strip()


def _search_score(query: str, text: str) -> float:
    if not query or not text:
        return 0.0
    query_folded = str(query).casefold().strip()
    text_folded = str(text).casefold()
    matches = re.findall(r'([+-]?)"([^"]+)"|([+-]?\S+)', query_folded)
    positive_terms: List[tuple[str, bool]] = []
    negative_terms: List[str] = []
    for quoted_operator, quoted, plain in matches:
        raw = quoted if quoted else plain
        operator = quoted_operator if quoted else (raw[0] if raw[:1] in "+-" else "")
        term = raw if quoted else (raw[1:] if operator else raw)
        term = term.strip()
        if not term:
            continue
        if operator == "-":
            negative_terms.append(term)
        else:
            positive_terms.append((term, bool(quoted)))

    if any(term in text_folded for term in negative_terms):
        return 0.0
    if not positive_terms:
        return 100.0

    text_words = re.findall(r"\w+", text_folded, flags=re.UNICODE)
    term_scores: List[float] = []
    for term, exact_phrase in positive_terms:
        if term in text_folded:
            term_scores.append(100.0)
            continue
        if exact_phrase or not _HAS_RAPIDFUZZ or not fuzz or len(term) < 4:
            return 0.0
        term_words = re.findall(r"\w+", term, flags=re.UNICODE)
        if len(term_words) != 1:
            return 0.0
        best_score = max((float(fuzz.ratio(term, word)) for word in text_words), default=0.0)
        threshold = 85.0 if len(term) <= 4 else 80.0
        if best_score < threshold:
            return 0.0
        term_scores.append(best_score)
    return sum(term_scores) / len(term_scores)


def _change_texts(newer: Dict[str, Any], older: Optional[Dict[str, Any]]) -> tuple[str, str]:
    if not older:
        return "", ""

    added: List[str] = []
    removed: List[str] = []
    for field in ("positive", "negative"):
        newer_tokens = re.findall(r"\S+", str(newer.get(field) or ""))
        older_tokens = re.findall(r"\S+", str(older.get(field) or ""))
        matcher = difflib.SequenceMatcher(None, older_tokens, newer_tokens, autojunk=False)
        for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
            if tag in ("insert", "replace"):
                added.extend(newer_tokens[new_start:new_end])
            if tag in ("delete", "replace"):
                removed.extend(older_tokens[old_start:old_end])
    return " ".join(added), " ".join(removed)


def _history_change_lookup(items: List[Dict[str, Any]]) -> Dict[str, tuple[str, str]]:
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for entry in items:
        group_id = str(entry.get("group_id") or "").strip()
        if group_id:
            groups.setdefault(group_id, []).append(entry)

    changes: Dict[str, tuple[str, str]] = {}
    for members in groups.values():
        members.sort(key=lambda item: int(item.get("last_used_at", 0) or 0), reverse=True)
        for index, entry in enumerate(members):
            key_hash = str(entry.get("key_hash") or "").strip()
            older = members[index + 1] if index + 1 < len(members) else None
            if key_hash:
                changes[key_hash] = _change_texts(entry, older)
    return changes


def _history_list_items(
    as_objects: bool = False,
    search_query: str = "",
    search_scope: str = "all",
):
    try:
        hist = _read_history(_DEFAULT_HISTORY_PATH)
        items = hist.get("items", [])
        scored_items: List[tuple[float, Dict[str, Any], str, str, str, str, str]] = []
        scope = str(search_scope or "all").strip().lower()
        if scope not in {"all", "current", "added", "removed"}:
            scope = "all"
        change_lookup = _history_change_lookup(items)

        import time as _t
        months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

        def fmt(ts: Any) -> str:
            try:
                value = int(float(str(ts).strip()))
                if value <= 0:
                    return ""
                lt = _t.localtime(value)
                return f"{lt.tm_mday:02d}{months[max(0, lt.tm_mon - 1)]}{lt.tm_hour:02d}:{lt.tm_min:02d}"
            except Exception:
                return ""

        for entry in items:
            kh = str(entry.get("key_hash") or "").strip()
            pos = str(entry.get("positive") or "").strip()
            neg = str(entry.get("negative") or "").strip()
            custom_name = str(entry.get("custom_name") or "").strip()
            added_text, removed_text = change_lookup.get(kh, ("", ""))
            current_text = "\n".join(part for part in (custom_name, pos, neg) if part)
            scope_texts = {
                "current": current_text,
                "added": added_text,
                "removed": removed_text,
                # Normal library search must only match text that exists in this saved prompt.
                "all": current_text,
            }
            matched_text = scope_texts[scope]

            clean_query = str(search_query or "").strip()
            if clean_query:
                score = _search_score(clean_query, matched_text)
                if score <= 0.0:
                    continue
                if custom_name and _search_score(clean_query, custom_name) > 0.0:
                    score = min(100.0, score + 3.0)
            else:
                score = 100.0

            if custom_name:
                label_text = custom_name
            else:
                label_text = pos.replace("\n", " ") or (("negative: " + neg.replace("\n", " ")) if neg else "")
                if len(label_text) > 60:
                    label_text = label_text[:60] + "…"

            ts = entry.get("last_used_at") or entry.get("created_at") or 0
            date_s = fmt(ts)
            if date_s and label_text:
                label = f"{date_s} — {label_text}"
            elif label_text:
                label = label_text
            elif kh:
                label = kh[:8]
            else:
                label = ""
            if not label:
                continue
            scored_items.append((score, entry, label, kh, added_text, removed_text, matched_text))

        scored_items.sort(key=lambda item: (-item[0], -int(item[1].get("last_used_at", 0) or 0)))

        if not as_objects:
            return True, [label for _, _, label, _, _, _, _ in scored_items]

        out = []
        for score, entry, label, kh, added_text, removed_text, matched_text in scored_items:
            out.append(
                {
                    "key_hash": kh,
                    "label_short": label,
                    "custom_name": str(entry.get("custom_name") or "").strip(),
                    "positive": str(entry.get("positive") or "").strip(),
                    "negative": str(entry.get("negative") or "").strip(),
                    "search_score": round(score, 2),
                    "created_at": int(entry.get("created_at", 0) or 0),
                    "last_used_at": int(entry.get("last_used_at", 0) or 0),
                    "hits": int(entry.get("hits", 0) or 0),
                    "group_id": str(entry.get("group_id") or "").strip(),
                    "lineage_note": str(entry.get("lineage_note") or "").strip(),
                    "added_text": added_text,
                    "removed_text": removed_text,
                    "matched_text": matched_text,
                    "search_scope": scope,
                }
            )
        return True, out
    except Exception as ex:
        return False, str(ex)


def _history_preview_payload(history_select: str):
    try:
        hist = _read_history(_DEFAULT_HISTORY_PATH)
        kh_pref = _parse_kh_prefix(history_select)
        for entry in hist.get("items", []):
            kh = str(entry.get("key_hash") or "")
            if not kh:
                continue
            if kh_pref and not kh.startswith(kh_pref):
                continue
            pos_text = str(entry.get("positive") or "")
            neg_text = str(entry.get("negative") or "")
            preview_text = (pos_text + ("\n---\n" + neg_text if neg_text else "")).strip()
            return True, {
                "preview_text": preview_text,
                "payload": {
                    "positive_raw": pos_text,
                    "negative_raw": neg_text,
                    "pos_text": pos_text,
                    "neg_text": neg_text,
                },
            }
        return False, {"error": "not_found", "message": "No history match"}
    except Exception as ex:
        return False, {"error": "exception", "message": str(ex)}


def _history_revision() -> str:
    candidate = _DEFAULT_HISTORY_PATH if os.path.isfile(_DEFAULT_HISTORY_PATH) else _DEFAULT_HISTORY_PATH + ".bak"
    try:
        stat = os.stat(candidate)
        return f"{stat.st_mtime_ns}:{stat.st_size}"
    except FileNotFoundError:
        return "missing"


def _history_status_payload() -> Dict[str, Any]:
    history = _read_history(_DEFAULT_HISTORY_PATH)
    backup_path = _DEFAULT_HISTORY_PATH + ".bak"
    backup_healthy = False
    if os.path.isfile(backup_path):
        try:
            _read_history_file(backup_path)
            backup_healthy = True
        except Exception:
            backup_healthy = False
    try:
        last_saved_at = int(os.path.getmtime(_DEFAULT_HISTORY_PATH))
    except OSError:
        last_saved_at = 0
    return {
        "total": len(history.get("items", [])),
        "last_saved_at": last_saved_at,
        "backup_healthy": backup_healthy,
    }


def _merge_imported_history(imported: Any) -> Dict[str, int]:
    if not isinstance(imported, dict) or not isinstance(imported.get("items"), list):
        raise HistoryStorageError("Import must contain a top-level items list")

    history = _read_history(_DEFAULT_HISTORY_PATH)
    current_items = [item for item in history.get("items", []) if isinstance(item, dict)]
    by_hash: Dict[str, Dict[str, Any]] = {}
    for item in current_items:
        key_hash = _compute_key_hash(_canonical_core(item))
        normalized = dict(item)
        normalized["key_hash"] = key_hash
        by_hash[key_hash] = normalized

    added = 0
    updated = 0

    def safe_int(value: Any, fallback: int = 0) -> int:
        try:
            return max(0, int(value or 0))
        except (TypeError, ValueError):
            return fallback

    for raw in imported["items"]:
        if not isinstance(raw, dict):
            continue
        positive = str(raw.get("positive") or "")
        negative = str(raw.get("negative") or "")
        if not positive.strip() and not negative.strip():
            continue
        key_hash = _compute_key_hash({"positive": positive, "negative": negative})
        existing = by_hash.get(key_hash)
        if existing is None:
            entry: Dict[str, Any] = {
                "key_hash": key_hash,
                "positive": positive,
                "negative": negative,
                "created_at": safe_int(raw.get("created_at")),
                "last_used_at": safe_int(raw.get("last_used_at")),
                "hits": max(1, safe_int(raw.get("hits"), 1)),
            }
            for field in ("custom_name", "group_id", "lineage_note"):
                value = str(raw.get(field) or "").strip()
                if value:
                    entry[field] = value
            by_hash[key_hash] = entry
            added += 1
            continue

        before = dict(existing)
        imported_created = safe_int(raw.get("created_at"))
        existing_created = safe_int(existing.get("created_at"))
        created_values = [value for value in (existing_created, imported_created) if value > 0]
        existing["created_at"] = min(created_values) if created_values else 0
        existing["last_used_at"] = max(
            safe_int(existing.get("last_used_at")),
            safe_int(raw.get("last_used_at")),
        )
        existing["hits"] = max(
            max(1, safe_int(existing.get("hits"), 1)),
            max(1, safe_int(raw.get("hits"), 1)),
        )
        for field in ("custom_name", "group_id", "lineage_note"):
            if not existing.get(field) and raw.get(field):
                existing[field] = str(raw[field]).strip()
        if existing != before:
            updated += 1

    merged_items = sorted(
        by_hash.values(),
        key=lambda item: int(item.get("last_used_at", 0) or 0),
        reverse=True,
    )
    history["schema"] = _SCHEMA_VERSION
    history["items"] = merged_items
    _write_history_atomic(_DEFAULT_HISTORY_PATH, history)
    return {"added": added, "updated": updated, "total": len(merged_items)}


class SimplePromptStandalone:
    DESCRIPTION = "Standalone simple prompt node with persistent searchable history."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": ("STRING", {"multiline": True, "default": ""}),
                "negative": ("STRING", {"multiline": True, "default": ""}),
            },
            "optional": {
                "history_group_id": ("STRING", {"default": ""}),
                "history_base_key": ("STRING", {"default": ""}),
                "history_base_positive": ("STRING", {"default": ""}),
                "history_lineage_nonce": ("STRING", {"default": ""}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive", "negative")
    FUNCTION = "execute_and_history"
    CATEGORY = "Simple Prompt"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        if not PG_ALWAYS_REROLL:
            return None
        positive_val = kwargs.get("positive", "")
        if has_choice_syntax(positive_val):
            try:
                return time.time_ns()
            except Exception:
                return time.time()
        return None

    def execute_and_history(
        self,
        positive,
        negative,
        history_group_id="",
        history_base_key="",
        history_base_positive="",
        history_lineage_nonce="",
        unique_id="",
    ):
        positive_orig = (positive or "").strip()
        negative_raw = (negative or "").strip()

        reroll = bool(PG_ALWAYS_REROLL)
        try:
            if "PG_REROLL" in os.environ:
                reroll = bool(int(os.environ.get("PG_REROLL", "0")))
        except Exception:
            pass

        seed = None
        if reroll:
            try:
                seed = time.time_ns() & 0xFFFFFFFF
            except Exception:
                seed = int(time.time() * 1000) & 0xFFFFFFFF

        pos_text = expand_choices(strip_prompt_comments(positive_orig), seed=seed)
        neg_text = strip_prompt_comments(negative_raw)

        session_key = (str(unique_id or ""), str(history_lineage_nonce or ""))
        with _LINEAGE_LOCK:
            session = _LINEAGE_SESSIONS.get(session_key)
        if session:
            history_group_id = session["group_id"]
            history_base_key = session["base_key"]
            history_base_positive = session["base_positive"]

        result = _save_history_entry(
            positive_orig,
            negative_raw,
            history_group_id,
            history_base_key,
            history_base_positive,
        )
        if result.get("saved"):
            with _LINEAGE_LOCK:
                _LINEAGE_SESSIONS[session_key] = {
                    "group_id": str(result.get("group_id") or result["key_hash"]),
                    "base_key": str(result["key_hash"]),
                    "base_positive": positive_orig,
                }
            print(f"[Simple Prompt history] saved: total={result['total']}")

        return (pos_text, neg_text)


NODE_CLASS_MAPPINGS = {
    "SimplePromptStandalone": SimplePromptStandalone,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SimplePromptStandalone": "Simple Prompt (Standalone)",
}


if PromptServer is not None and web is not None:
    _ROUTES_FLAG = "_simple_prompt_history_routes_registered_v1"
    if not getattr(PromptServer.instance, _ROUTES_FLAG, False):
        routes = PromptServer.instance.routes

        @routes.post("/simple_prompt/history/revision")
        async def simple_prompt_history_revision(request):
            return web.json_response({"ok": True, "revision": _history_revision()})

        @routes.post("/simple_prompt/history/status")
        async def simple_prompt_history_status(request):
            try:
                with _HIST_LOCK:
                    payload = _history_status_payload()
                return web.json_response({"ok": True, **payload})
            except Exception as ex:
                return web.json_response({"ok": False, "error": str(ex)}, status=500)

        @routes.post("/simple_prompt/history/export")
        async def simple_prompt_history_export(request):
            try:
                with _HIST_LOCK:
                    history = _read_history(_DEFAULT_HISTORY_PATH)
                return web.json_response(
                    {
                        "ok": True,
                        "exported_at": int(time.time()),
                        "schema": int(history.get("schema", _SCHEMA_VERSION) or _SCHEMA_VERSION),
                        "items": history.get("items", []),
                    }
                )
            except Exception as ex:
                return web.json_response({"ok": False, "error": str(ex)}, status=500)

        @routes.post("/simple_prompt/history/import")
        async def simple_prompt_history_import(request):
            try:
                try:
                    imported = await request.json()
                except Exception as ex:
                    raise HistoryStorageError(f"Import is not valid JSON: {ex}") from ex
                with _HIST_LOCK:
                    result = _merge_imported_history(imported)
                return web.json_response({"ok": True, **result})
            except HistoryStorageError as ex:
                return web.json_response({"ok": False, "error": str(ex)}, status=400)
            except Exception as ex:
                return web.json_response({"ok": False, "error": str(ex)}, status=500)

        @routes.post("/simple_prompt/history/list")
        async def simple_prompt_history_list(request):
            try:
                data = await request.json()
            except Exception:
                data = {}
            as_objects = bool(data.get("objects"))
            search_query = str(data.get("search_query", "")).strip()
            search_scope = str(data.get("search_scope", "all")).strip()
            with _HIST_LOCK:
                ok, res = _history_list_items(
                    as_objects=as_objects,
                    search_query=search_query,
                    search_scope=search_scope,
                )
            if ok:
                return web.json_response({"ok": True, "items": res})
            return web.json_response({"ok": False, "error": res})

        @routes.post("/simple_prompt/history/preview")
        async def simple_prompt_history_preview(request):
            try:
                data = await request.json()
            except Exception:
                data = {}
            history_select = str(data.get("history_select", "none"))
            with _HIST_LOCK:
                ok, res = _history_preview_payload(history_select)
            if ok:
                return web.json_response({"ok": True, **res})
            return web.json_response({"ok": False, **res})

        @routes.post("/simple_prompt/history/rename")
        async def simple_prompt_history_rename(request):
            try:
                data = await request.json()
            except Exception:
                data = {}
            history_select = str(data.get("history_select", ""))
            custom_name = str(data.get("custom_name", "")).strip()
            kh_pref = _parse_kh_prefix(history_select)
            if not kh_pref:
                return web.json_response({"ok": False, "error": "invalid_key_hash"})
            try:
                with _HIST_LOCK:
                    hist = _read_history(_DEFAULT_HISTORY_PATH)
                    items = hist.get("items", [])
                    for entry in items:
                        kh = str(entry.get("key_hash", ""))
                        if kh and kh.startswith(kh_pref):
                            if custom_name:
                                entry["custom_name"] = custom_name
                            else:
                                entry.pop("custom_name", None)
                            hist["items"] = items
                            _write_history_atomic(_DEFAULT_HISTORY_PATH, hist)
                            return web.json_response({"ok": True, "custom_name": custom_name})
                return web.json_response({"ok": False, "error": "not_found"})
            except Exception as ex:
                return web.json_response({"ok": False, "error": "exception", "message": str(ex)})

        @routes.post("/simple_prompt/history/ungroup")
        async def simple_prompt_history_ungroup(request):
            try:
                data = await request.json()
            except Exception:
                data = {}
            key_hash = str(data.get("key_hash", "")).strip()
            if not key_hash:
                return web.json_response({"ok": False, "error": "invalid_key_hash"})
            try:
                with _HIST_LOCK:
                    hist = _read_history(_DEFAULT_HISTORY_PATH)
                    items = hist.get("items", [])
                    target = next((item for item in items if item.get("key_hash") == key_hash), None)
                    if target is None:
                        return web.json_response({"ok": False, "error": "not_found"})
                    old_group = str(target.pop("group_id", "") or "")
                    if old_group:
                        remaining = [item for item in items if item.get("group_id") == old_group]
                        if len(remaining) == 1:
                            remaining[0].pop("group_id", None)
                    hist["items"] = items
                    _write_history_atomic(_DEFAULT_HISTORY_PATH, hist)
                return web.json_response({"ok": True})
            except Exception as ex:
                return web.json_response({"ok": False, "error": "exception", "message": str(ex)})

        setattr(PromptServer.instance, _ROUTES_FLAG, True)
