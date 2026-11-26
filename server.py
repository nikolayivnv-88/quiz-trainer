"""Quiz Zagryavka: a dependency-free, loopback-only quiz application."""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sqlite3
import unicodedata
import uuid
import webbrowser
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
CATEGORIES = {"history": "История", "geography": "География", "bulgaria": "България", "science": "Наука", "sport": "Спорт", "cinema": "Кино", "music": "Музика", "literature": "Литература"}
from seed_pack import CATEGORIES as NEW_CATEGORIES
CATEGORIES.update(NEW_CATEGORIES)
MEDIA = json.loads((ROOT / 'static/media/credits.json').read_text('utf-8'))
MEDIA_BY_PATH = {item['path']: item for item in MEDIA.values()}
DIFFICULTIES = {"easy": "Лесно", "medium": "Средно", "hard": "Трудно"}
MODES = {"quick": "Бърза загрявка", "topic": "Тренировка", "full": "Генерална репетиция", "retry": "Втори шанс"}


class AppError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def now():
    return datetime.now(timezone.utc).isoformat()


def uid():
    return uuid.uuid4().hex


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def fingerprint(text):
    text = unicodedata.normalize("NFKC", text).casefold()
    return hashlib.sha256("".join(c for c in text if c.isalnum()).encode()).hexdigest()


def normalize_answer(text):
    text = unicodedata.normalize("NFKC", text).casefold().strip()
    # Decimal comma and point are equivalent; signs and decimal values matter.
    text = re.sub(r"(?<=\d),(?=\d)", ".", text)
    text = re.sub(r"(?<=[^\W\d_])[-‐‑–—](?=[^\W\d_])", " ", text)
    text = "".join(c if c.isalnum() or c.isspace() or
                   (c == "." and i > 0 and i + 1 < len(text) and text[i-1].isdigit() and text[i+1].isdigit()) or
                   (c in "+-−" and i + 1 < len(text) and text[i+1].isdigit())
                   else " " for i, c in enumerate(text))
    return " ".join(text.replace("−", "-").split())


def check_answer(question, text):
    normalized = normalize_answer(text)
    return bool(normalized) and any(normalized == normalize_answer(candidate)
                                    for candidate in [question["answer"], *question["alternatives"]])


def string(value, name, maximum=2000, required=True):
    if not isinstance(value, str) or len(value) > maximum or (required and not value.strip()):
        raise AppError(f"Невалидно поле: {name}.")
    return value.strip()


def question_fields(value):
    if not isinstance(value, dict):
        raise AppError("Невалиден въпрос.")
    result = {k: string(value.get(k), label, maximum) for k, label, maximum in (
        ("prompt", "въпрос", 1500), ("answer", "отговор", 500), ("explanation", "обяснение", 2000))}
    for key, choices in (("category", CATEGORIES), ("difficulty", DIFFICULTIES)):
        if not isinstance(value.get(key), str) or value[key] not in choices:
            raise AppError(f"Невалидно поле: {key}.")
        result[key] = value[key]
    alternatives = value.get("alternatives", [])
    if not isinstance(alternatives, list):
        raise AppError("Допустимите варианти трябва да са списък.")
    result["alternatives"] = [string(a, "вариант", 2000) for a in alternatives]
    image = value.get('image')
    if image is not None:
        if not isinstance(image, dict) or not isinstance(image.get('path'), str) or image['path'] not in MEDIA_BY_PATH:
            raise AppError('Невалидно изображение.')
        image = {k: MEDIA_BY_PATH[image['path']][k] for k in
                 ('path', 'credit', 'license', 'source_url', 'license_url', 'changes')}
    result['image'] = image
    return result


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "quiz.sqlite3"
        with self.db() as db:
            fresh_database = not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='questions'").fetchone()
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS questions (
                    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE,
                    category TEXT NOT NULL, difficulty TEXT NOT NULL,
                    prompt TEXT NOT NULL, answer TEXT NOT NULL,
                    alternatives TEXT NOT NULL, explanation TEXT NOT NULL,
                    origin TEXT NOT NULL, source_url TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, image TEXT);
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL);
            """)
            db.execute("BEGIN IMMEDIATE")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version < 2:
                for row in db.execute("SELECT id,state FROM sessions").fetchall():
                    session = json.loads(row["state"])
                    session.pop("timer_seconds", None)
                    session.pop("deadline", None)
                    submitted = session["index"] if session["status"] == "playing" else session["index"] + 1
                    if session["status"] == "completed":
                        submitted = len(session["answers"])
                    for i, answer in enumerate(session["answers"]):
                        answer.pop("timed_out", None)
                        if i < submitted and answer["correct"] is None:
                            answer.update(correct=check_answer(session["questions"][i], answer["text"]),
                                          graded_at=session["updated_at"])
                    session["revision"] += 1
                    db.execute("UPDATE sessions SET state=? WHERE id=?", (encode(session), session["id"]))
            if version < 3:
                if any(row["name"] == "status" for row in db.execute("PRAGMA table_info(questions)")):
                    db.execute("ALTER TABLE questions DROP COLUMN status")
                for row in db.execute("SELECT id,state FROM sessions").fetchall():
                    session = json.loads(row["state"])
                    for question in session["questions"]:
                        question.pop("status", None)
                    for answer in session["answers"]:
                        answer.pop("confidence", None)
                    session["revision"] += 1
                    db.execute("UPDATE sessions SET state=? WHERE id=?", (encode(session), session["id"]))
            if not any(row['name'] == 'image' for row in db.execute('PRAGMA table_info(questions)')):
                db.execute('ALTER TABLE questions ADD COLUMN image TEXT')
            if fresh_database or version < 5:
                from seed import QUESTIONS
                for item in QUESTIONS:
                    if fresh_database or item.get('pack_version',1) > max(version,3):
                        self.insert_question(item, "seed", item["id"], item.get("source_url"), db=db)
            db.execute("PRAGMA user_version=5")

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.path, timeout=20)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def put_state(db, table, state):
        assert table == "sessions"
        state["updated_at"] = now()
        db.execute(f"INSERT INTO {table}(id,state,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at", (state["id"], encode(state), state["updated_at"]))

    def state(self, table, identity):
        assert table == "sessions"
        with self.db() as db:
            row = db.execute(f"SELECT state FROM {table} WHERE id=?", (identity,)).fetchone()
        if not row:
            raise AppError("Записът не е намерен.", 404)
        return json.loads(row["state"])

    def states(self, table):
        assert table == "sessions"
        with self.db() as db:
            rows = db.execute(f"SELECT state FROM {table} ORDER BY updated_at DESC").fetchall()
        return [json.loads(row["state"]) for row in rows]

    @staticmethod
    def unpack_question(row):
        result = dict(row)
        result["alternatives"] = json.loads(result["alternatives"])
        result['image'] = json.loads(result['image']) if result['image'] else None
        return result

    def questions(self):
        with self.db() as db:
            return [self.unpack_question(r) for r in db.execute("SELECT * FROM questions ORDER BY created_at DESC,id")]

    def insert_question(self, value, origin, identity=None, source=None, db=None):
        fields = question_fields(value)
        identity = identity or uid()
        def insert(connection):
            cursor = connection.execute("INSERT OR IGNORE INTO questions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                identity, fingerprint(fields["prompt"]), fields["category"], fields["difficulty"], fields["prompt"], fields["answer"], encode(fields["alternatives"]), fields["explanation"], origin, source, now(), now(), encode(fields['image']) if fields['image'] else None))
            return identity if cursor.rowcount else None
        if db is not None:
            return insert(db)
        with self.db() as connection:
            return insert(connection)

    def update_question(self, identity, value):
        fields = question_fields(value)
        with self.db() as db:
            previous = db.execute("SELECT * FROM questions WHERE id=?", (identity,)).fetchone()
            if not previous:
                raise AppError("Въпросът не е намерен.", 404)
            # A source applies to the original wording. Editing never inherits its verification.
            changed = any(fields[k] != self.unpack_question(previous)[k] for k in fields)
            source = None if changed else previous["source_url"]
            try:
                db.execute("UPDATE questions SET fingerprint=?,category=?,difficulty=?,prompt=?,answer=?,alternatives=?,explanation=?,image=?,source_url=?,updated_at=? WHERE id=?", (
                    fingerprint(fields["prompt"]), fields["category"], fields["difficulty"], fields["prompt"], fields["answer"], encode(fields["alternatives"]), fields["explanation"], encode(fields['image']) if fields['image'] else None, source, now(), identity))
            except sqlite3.IntegrityError:
                raise AppError("Вече има въпрос със същото условие.", 409)
        return {"ok": True}

    def delete_question(self, identity):
        with self.db() as db:
            if not db.execute("DELETE FROM questions WHERE id=?", (identity,)).rowcount:
                raise AppError("Въпросът не е намерен.", 404)
        return {"ok": True}

    def delete_session(self, identity):
        with self.db() as db:
            if not db.execute("DELETE FROM sessions WHERE id=?",(identity,)).rowcount:
                raise AppError("Тренировката не е намерена.",404)
        return {"ok":True}

    def latest_grades(self):
        latest = {}
        for session in self.states("sessions"):
            for q, answer in zip(session["questions"], session["answers"]):
                if answer["correct"] is not None:
                    stamp = answer.get("graded_at", session["updated_at"])
                    if q["id"] not in latest or stamp > latest[q["id"]][0]:
                        latest[q["id"]] = (stamp, answer["correct"])
        return latest

    def summary(self):
        sessions = self.states("sessions")
        questions = self.questions()
        categories = {key: {"total": 0, "correct": 0} for key in CATEGORIES}
        for session in sessions:
            for q, answer in zip(session["questions"], session["answers"]):
                if answer["correct"] is None:
                    continue
                bucket = categories[q["category"]]
                bucket["total"] += 1
                bucket["correct"] += int(answer["correct"])
        missed = {key for key, (_, correct) in self.latest_grades().items() if not correct}
        return {
            "categories": CATEGORIES, "difficulties": DIFFICULTIES, "modes": MODES,
            "stats": {"bank": len(questions), "visual": sum(bool(q.get('image')) for q in questions), "completed": sum(s["status"] == "completed" for s in sessions), "missed": sum(q["id"] in missed for q in questions), "categories": categories},
            "missed_ids": [q["id"] for q in questions if q["id"] in missed],
            "sessions": [session_brief(s) for s in sessions],
        }

    def available(self, config):
        questions = self.questions()
        questions = [q for q in questions if q["category"] in config["categories"] and (config["difficulty"] == "mixed" or q["difficulty"] == config["difficulty"])]
        if config["mode"] == "retry":
            missed = {key for key, (_, correct) in self.latest_grades().items() if not correct}
            questions = [q for q in questions if q["id"] in missed]
        return questions

    def create_session(self, value):
        config = validate_config(value)
        questions = self.available(config)
        required = config["count"]
        if config["mode"] == "retry":
            required = min(required, len(questions))
        if not required or len(questions) < required:
            raise AppError(f"Налични са {len(questions)} въпроса за този избор, а са нужни {config['count']}. Променете филтрите или намалете броя.")
        # Round-robin through shuffled categories for an actually mixed warm-up.
        groups = {}
        random.shuffle(questions)
        for q in questions:
            groups.setdefault(q["category"], []).append(q)
        chosen = []
        while len(chosen) < required:
            keys = list(groups)
            random.shuffle(keys)
            for key in keys:
                chosen.append(groups[key].pop())
                if not groups[key]:
                    del groups[key]
                if len(chosen) == required:
                    break
        # Surface the visual format without disturbing category balance or retry eligibility.
        if not any(q.get('image') for q in chosen):
            visual = [q for q in questions if q.get('image') and q['category'] in {c['category'] for c in chosen}]
            if visual:
                replacement = random.choice(visual)
                target = next(i for i, q in enumerate(chosen) if q['category'] == replacement['category'])
                chosen[target] = replacement
        session = {"id": uid(), "mode": config["mode"], "name": MODES[config["mode"]], "status": "playing", "index": 0, "round_size": 10, "revision": 0, "created_at": now(), "questions": chosen, "answers": [{"text": "", "correct": None} for _ in chosen]}
        with self.db() as db:
            self.put_state(db, "sessions", session)
        return session

    def act_session(self, identity, value):
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT state FROM sessions WHERE id=?", (identity,)).fetchone()
            if not row:
                raise AppError("Играта не е намерена.", 404)
            session = json.loads(row["state"])
            if value.get("revision") != session["revision"]:
                raise AppError("Играта е променена в друг прозорец. Презаредете, за да продължите.", 409)
            action = value.get("action")
            index = session["index"]
            start = index // 10 * 10
            end = min(start + 10, len(session["questions"]))
            if action in ("save_answer", "next"):
                if session["status"] != "playing":
                    raise AppError("Този кръг вече е предаден.")
                if value.get("question_index") != index:
                    raise AppError("Този въпрос вече е предаден. Презаредете играта, за да продължите.", 409)
                text = string(value.get("text", ""), "вашият отговор", 2000, required=False)
                answer = session["answers"][index]
                answer.update(text=text)
                if action == "next":
                    answer.update(correct=check_answer(session["questions"][index], text), graded_at=now())
                    if index + 1 == end:
                        session.update(status="review")
                    else:
                        session["index"] += 1
            elif action == "accept_answer":
                target = value.get("index")
                if (session["status"] not in ("review", "completed") or type(target) is not int
                        or not 0 <= target < len(session["answers"])
                        or (session["status"] == "review" and not start <= target < end)):
                    raise AppError("Можете да приемете отговор само в ревюто.")
                answer = session["answers"][target]
                if answer["correct"] is not False:
                    raise AppError("Този отговор вече е отчетен като верен.", 409)
                text = string(answer["text"], "подаденият отговор", 2000)
                if not normalize_answer(text):
                    raise AppError("Няма подаден отговор за приемане.")
                question = session["questions"][target]
                bank_row = db.execute("SELECT * FROM questions WHERE id=?", (question["id"],)).fetchone()
                learned = False
                if bank_row:
                    bank = self.unpack_question(bank_row)
                    # Historical approval must not teach a different, subsequently edited question.
                    same_question = (bank["prompt"] == question["prompt"]
                                     and bank["answer"] == question["answer"]
                                     and bank.get("image") == question.get("image"))
                    if same_question:
                        if not check_answer(bank, text):
                            bank["alternatives"].append(text)
                            db.execute("UPDATE questions SET alternatives=?,updated_at=? WHERE id=?",
                                       (encode(bank["alternatives"]), now(), question["id"]))
                        learned = True
                if not check_answer(question, text):
                    question["alternatives"].append(text)
                stamp = now()
                answer.update(correct=True, graded_at=stamp, accepted_at=stamp, variant_saved=learned)
            elif action == "next_round":
                if session["status"] != "review":
                    raise AppError("Първо предайте кръга.")
                if end == len(session["questions"]):
                    session.update(status="completed")
                else:
                    session.update(status="playing", index=end)
            else:
                raise AppError("Непознато действие.")
            session["revision"] += 1
            self.put_state(db, "sessions", session)
            return session


def validate_config(value):
    if not isinstance(value, dict):
        raise AppError("Невалидни настройки.")
    mode = value.get("mode", "quick")
    if not isinstance(mode, str) or mode not in MODES:
        raise AppError("Невалиден режим.")
    categories = value.get("categories", list(CATEGORIES))
    if not isinstance(categories, list) or not categories or any(not isinstance(c, str) or c not in CATEGORIES for c in categories):
        raise AppError("Изберете поне една категория.")
    difficulty = value.get("difficulty", "mixed")
    if not isinstance(difficulty, str) or difficulty not in (*DIFFICULTIES, "mixed"):
        raise AppError("Невалидна трудност.")
    count = 51 if mode == "full" else 10 if mode == "quick" else value.get("count", 10)
    if type(count) is not int or not 1 <= count <= 51:
        raise AppError("Броят въпроси трябва да е между 1 и 51.")
    return dict(mode=mode, categories=list(dict.fromkeys(categories)), difficulty=difficulty, count=count)


def session_brief(session):
    answers = session["answers"]
    return {key: session[key] for key in ("id", "name", "mode", "status", "created_at", "updated_at", "index")} | {"count": len(answers), "graded": sum(a["correct"] is not None for a in answers), "correct": sum(a["correct"] is True for a in answers)}


class Handler(BaseHTTPRequestHandler):
    server_version = "QuizZagryavka/1.0"

    def log_message(self, format, *args):
        # Keep quiz answers and request bodies out of logs.
        pass

    def send(self, status, body, content_type="application/json; charset=utf-8"):
        raw = encode(body).encode() if "application/json" in content_type else body
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def guard(self, write=False):
        host = self.headers.get("Host", "")
        allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if host not in allowed:
            raise AppError("Разрешен е само локален достъп.", 403)
        origin = self.headers.get("Origin")
        if origin and origin not in {"http://" + host}:
            raise AppError("Неразрешен произход на заявката.", 403)
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise AppError("Неразрешена външна заявка.", 403)
        if write and self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            raise AppError("Изисква се application/json.", 415)

    def body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 1_000_000:
                raise AppError("Невалиден размер на заявката.")
            value = json.loads(self.rfile.read(length))
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError):
            raise AppError("Невалиден JSON.")

    def dispatch(self, method):
        try:
            self.guard(method not in ("GET", "DELETE"))
            path = urlparse(self.path).path
            store = self.server.store
            if method == "GET":
                if path == "/api/bootstrap":
                    return self.send(200, store.summary())
                if path == "/api/questions":
                    query = parse_qs(urlparse(self.path).query)
                    questions = store.questions()
                    for key in ("category", "difficulty"):
                        selected = query.get(key, [""])[0]
                        if selected:
                            questions = [q for q in questions if q[key] == selected]
                    search = query.get("q", [""])[0].casefold().strip()
                    if search:
                        questions = [q for q in questions if search in q["prompt"].casefold() or search in q["answer"].casefold()]
                    return self.send(200, {"questions": questions})
                if re.fullmatch(r"/api/sessions/[a-f0-9]{32}", path):
                    return self.send(200, store.state("sessions", path.split("/")[-1]))
                if path.startswith("/api/"):
                    raise AppError("Адресът не е намерен.", 404)
                if path in MEDIA_BY_PATH:
                    mime = 'image/svg+xml' if path.endswith('.svg') else 'image/jpeg'
                    return self.send(200, (ROOT / 'static' / path.lstrip('/')).read_bytes(), mime)
                static = {"/theme.js": ("theme.js", "application/javascript; charset=utf-8"), "/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "application/javascript; charset=utf-8"), "/style.css": ("style.css", "text/css; charset=utf-8"), "/favicon.svg": ("favicon.svg", "image/svg+xml"), "/fonts/InterVariable.woff2": ("fonts/InterVariable.woff2", "font/woff2")}
                if path not in static:
                    raise AppError("Адресът не е намерен.", 404)
                filename, mime = static[path]
                return self.send(200, (ROOT / "static" / filename).read_bytes(), mime)
            if method == "DELETE" and re.fullmatch(r"/api/sessions/[a-f0-9]{32}", path):
                return self.send(200,store.delete_session(path.split("/")[-1]))
            if method == "DELETE" and re.fullmatch(r"/api/questions/[a-z0-9-]+", path):
                return self.send(200, store.delete_question(path.split("/")[-1]))
            value = self.body()
            if method == "POST" and path == "/api/sessions":
                return self.send(201, store.create_session(value))
            if method == "PATCH" and re.fullmatch(r"/api/sessions/[a-f0-9]{32}", path):
                return self.send(200, store.act_session(path.split("/")[-1], value))
            if method == "PUT" and re.fullmatch(r"/api/questions/[a-z0-9-]+", path):
                return self.send(200, store.update_question(path.split("/")[-1], value))
            raise AppError("Адресът не е намерен.", 404)
        except AppError as error:
            self.send(error.status, {"error": str(error)})
        except Exception:
            self.send(500, {"error": "Възникна неочаквана грешка. Презаредете страницата; запазените данни остават налични."})

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def do_DELETE(self):
        self.dispatch("DELETE")


def make_server(directory, port=8767):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.store = Store(directory)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description="Куиз Загрявка — локален куиз треньор")
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--open", action="store_true", help="Open the local application in your browser")
    args = parser.parse_args()
    try:
        server = make_server(args.data_dir, args.port)
    except OSError:
        print(f"Port {args.port} is unavailable. Try: python server.py --port 8768 --open", flush=True)
        return 1
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"Quiz Zagryavka: {url}\nDatabase: {server.store.path}\nPress Ctrl+C to stop.", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nQuiz Zagryavka stopped.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
