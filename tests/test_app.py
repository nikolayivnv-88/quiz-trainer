import json
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

import server


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = server.Store(self.temp.name)

    def act(self, session, action, **fields):
        return self.store.act_session(session["id"], {"revision":session["revision"],"question_index":session["index"],"action":action,**fields})

    def finish_round(self, session, correct=True):
        while session["status"] == "playing":
            session = self.act(session,"next",text=session["questions"][session["index"]]["answer"] if correct else "Грешен отговор")
        return self.act(session,"next_round")

    def test_seed_is_idempotent_and_full_quiz_is_balanced_unique(self):
        server.Store(self.temp.name)
        self.assertEqual(len(self.store.questions()),480)
        session = self.store.create_session({"mode":"full"})
        self.assertEqual(len(session["questions"]),51)
        self.assertEqual(len({q["id"] for q in session["questions"]}),51)
        self.assertEqual({q["category"] for q in session["questions"][:len(server.CATEGORIES)]},set(server.CATEGORIES))

    def test_no_timer_save_and_restart_preserve_draft(self):
        s = self.store.create_session({"mode":"quick"})
        s = self.act(s,"save_answer",text="София")
        restored = server.Store(self.temp.name).state("sessions",s["id"])
        self.assertNotIn("deadline",restored)
        self.assertNotIn("timer_seconds",restored)
        self.assertIsNone(restored["answers"][0]["correct"])
        self.assertEqual(restored["answers"][0]["text"],"София")
        self.assertNotIn("confidence",restored["answers"][0])
        self.assertEqual(restored["revision"],1)

    def test_legacy_config_cannot_enable_removed_features(self):
        s = self.store.create_session({"timer_seconds":30,"include_unverified":True,"job_id":"a"*32})
        self.assertNotIn("timer_seconds",s)
        self.assertNotIn("deadline",s)
        self.assertTrue(all("status" not in q for q in s["questions"]))

    def test_all_51_questions_auto_grade_including_bonus_and_finish_in_six_rounds(self):
        s = self.store.create_session({"mode":"full"})
        with self.assertRaises(server.AppError): self.act(s,"next_round")
        for expected_start in (10,20,30,40,50):
            s = self.finish_round(s)
            self.assertEqual(s["index"],expected_start)
        s = self.finish_round(s)
        self.assertEqual(s["status"],"completed")
        self.assertEqual(sum(a["correct"] is True for a in s["answers"]),51)
        self.assertEqual(self.store.summary()["stats"]["completed"],1)

    def test_round_is_automatically_scored_and_needs_no_manual_grading(self):
        s = self.store.create_session({"mode":"quick"})
        for i in range(10):
            text = s["questions"][i]["alternatives"][0] if i < 8 else "Грешен" if i == 8 else ""
            s = self.act(s,"next",text=text)
        self.assertEqual(s["status"],"review")
        self.assertEqual([a["correct"] for a in s["answers"]],[True]*8+[False,False])
        self.assertTrue(all(a.get("graded_at") for a in s["answers"]))
        with self.assertRaises(server.AppError): self.act(s,"grade",index=8,correct=True)
        s = self.act(s,"next_round")
        self.assertEqual(s["status"],"completed")
        self.assertEqual(self.store.summary()["stats"]["missed"],2)

    def test_stale_revision_and_duplicate_submit_are_rejected(self):
        s = self.store.create_session({})
        self.act(s,"next")
        with self.assertRaises(server.AppError) as caught: self.act(s,"next")
        self.assertEqual(caught.exception.status,409)
        self.assertEqual(self.store.state("sessions",s["id"])["index"],1)

    def test_late_autosave_cannot_overwrite_next_question(self):
        s = self.store.create_session({})
        s = self.act(s,"next",text="Първи отговор")
        with self.assertRaises(server.AppError):
            self.store.act_session(s["id"],{"revision":s["revision"],"action":"save_answer","question_index":0,"text":"Късен първи отговор"})
        saved = self.store.state("sessions",s["id"])
        self.assertEqual(saved["answers"][0]["text"],"Първи отговор")
        self.assertEqual(saved["answers"][1]["text"],"")

    def test_retry_uses_latest_grade(self):
        s = self.store.create_session({"mode":"topic","count":5})
        s = self.finish_round(s,correct=False)
        missed = {q["id"] for q in s["questions"]}
        self.assertEqual(self.store.summary()["stats"]["missed"],5)
        retry = self.store.create_session({"mode":"retry","count":10})
        self.assertEqual({q["id"] for q in retry["questions"]},missed)
        self.finish_round(retry,correct=True)
        self.assertEqual(self.store.summary()["stats"]["missed"],0)
        with self.assertRaises(server.AppError): self.store.create_session({"mode":"retry"})

    def test_edited_questions_do_not_modify_live_snapshots_or_reseed(self):
        s = self.store.create_session({})
        q = s["questions"][0]
        self.store.update_question(q["id"],{**q,"answer":"Редактиран отговор"})
        restored = server.Store(self.temp.name)
        live = restored.state("sessions",s["id"])
        self.assertEqual(live["questions"][0]["answer"],q["answer"])
        bank_q = next(x for x in restored.questions() if x["id"] == q["id"])
        self.assertEqual(bank_q["answer"],"Редактиран отговор")
        self.assertIsNone(bank_q["source_url"])
        self.assertNotIn("status",bank_q)

    def test_delete_is_permanent_after_restart_and_preserves_session_snapshot(self):
        s = self.store.create_session({"mode":"topic","count":1})
        s = self.finish_round(s,correct=False)
        question = s["questions"][0]
        self.store.delete_question(question["id"])
        restored = server.Store(self.temp.name)
        self.assertEqual(len(restored.questions()),479)
        self.assertNotIn(question["id"],{q["id"] for q in restored.questions()})
        self.assertEqual(restored.state("sessions",s["id"]),s)
        self.assertEqual(restored.summary()["stats"]["missed"],0)
        self.assertEqual(restored.summary()["stats"]["completed"],1)
        with self.assertRaises(server.AppError) as error: restored.delete_question(question["id"])
        self.assertEqual(error.exception.status,404)

    def test_deleting_every_question_does_not_reseed_and_reports_shortage(self):
        for q in self.store.questions(): self.store.delete_question(q["id"])
        restored = server.Store(self.temp.name)
        self.assertEqual(restored.questions(),[])
        with self.assertRaises(server.AppError): restored.create_session({})

    def test_delete_during_play_keeps_question_and_answer_checking_in_current_game(self):
        s = self.store.create_session({"mode":"topic","count":1})
        q = s["questions"][0]
        self.store.delete_question(q["id"])
        s = self.act(s,"next",text=q["answer"])
        self.assertTrue(s["answers"][0]["correct"])
        self.assertEqual(self.act(s,"next_round")["status"],"completed")

    def test_duplicates_ignore_case_spacing_and_punctuation(self):
        q = self.store.questions()[0]
        self.assertIsNone(self.store.insert_question({**q,"prompt":q["prompt"].upper()+" !!!"},"legacy"))

    def test_invalid_configs_and_shortage(self):
        for config in ({"mode":{}},{"categories":[]},{"categories":[{}]},{"difficulty":[]},{"mode":"topic","count":0}):
            with self.subTest(config=config), self.assertRaises(server.AppError): server.validate_config(config)
        with self.assertRaises(server.AppError):
            self.store.create_session({"mode":"full","categories":["history"]})

    def test_old_review_is_migrated_without_losing_answers_or_existing_grades(self):
        s = self.store.create_session({"mode":"quick"})
        for i in range(10):
            s = self.act(s,"next",text=s["questions"][i]["answer"])
        s.update(timer_seconds=30,deadline=123)
        stamp = s["updated_at"]
        for a in s["answers"]:
            a.update(correct=None,timed_out=False)
            a.pop("graded_at",None)
        s["answers"][0].update(correct=False,graded_at="2020-01-01T00:00:00+00:00")
        with self.store.db() as db:
            db.execute("UPDATE sessions SET state=? WHERE id=?",(server.encode(s),s["id"]))
            db.execute("PRAGMA user_version=1")
        restored = server.Store(self.temp.name)
        migrated = restored.state("sessions",s["id"])
        self.assertNotIn("timer_seconds",migrated)
        self.assertNotIn("deadline",migrated)
        self.assertEqual(migrated["updated_at"],stamp)
        self.assertEqual(migrated["answers"][0]["correct"],False)
        self.assertTrue(all(a["correct"] for a in migrated["answers"][1:]))
        self.assertTrue(all("timed_out" not in a for a in migrated["answers"]))
        self.assertEqual(self.act(migrated,"next_round")["status"],"completed")
        again = server.Store(self.temp.name).state("sessions",s["id"])
        self.assertEqual(again["revision"],migrated["revision"]+1)

    def test_old_playing_game_grades_submitted_answers_and_keeps_current_draft(self):
        s = self.store.create_session({})
        s = self.act(s,"next",text=s["questions"][0]["answer"])
        s = self.act(s,"save_answer",text="Моята чернова")
        s["answers"][0]["correct"] = None
        s.update(timer_seconds=30,deadline=1)
        with self.store.db() as db:
            db.execute("UPDATE sessions SET state=? WHERE id=?",(server.encode(s),s["id"]))
            db.execute("PRAGMA user_version=1")
        migrated = server.Store(self.temp.name).state("sessions",s["id"])
        self.assertTrue(migrated["answers"][0]["correct"])
        self.assertEqual(migrated["answers"][1]["text"],"Моята чернова")
        self.assertIsNone(migrated["answers"][1]["correct"])
        self.assertNotIn("confidence",migrated["answers"][1])
        self.assertEqual(migrated["index"],1)

    def test_version_two_migration_removes_status_and_confidence_without_changing_results(self):
        s = self.store.create_session({"mode":"topic","count":1})
        s = self.act(s,"save_answer",text="Запазена чернова")
        for q in s["questions"]: q["status"]="approved"
        for a in s["answers"]: a["confidence"]="know"
        with self.store.db() as db:
            db.execute("ALTER TABLE questions ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'")
            db.execute("UPDATE sessions SET state=? WHERE id=?",(server.encode(s),s["id"]))
            db.execute("PRAGMA user_version=2")
        restored = server.Store(self.temp.name)
        migrated = restored.state("sessions",s["id"])
        self.assertEqual(migrated["answers"][0]["text"],"Запазена чернова")
        self.assertIsNone(migrated["answers"][0]["correct"])
        self.assertEqual(migrated["updated_at"],s["updated_at"])
        self.assertNotIn("confidence",migrated["answers"][0])
        self.assertNotIn("status",migrated["questions"][0])
        with restored.db() as db:
            self.assertNotIn("status",[r["name"] for r in db.execute("PRAGMA table_info(questions)")])
        self.assertNotIn("confidence",restored.summary()["stats"])
        self.assertNotIn("approved",restored.summary()["stats"])
        s = self.act(migrated,"next",text=migrated["questions"][0]["answer"])
        self.assertTrue(s["answers"][0]["correct"])
        self.assertEqual(self.act(s,"next_round")["status"],"completed")

    def test_only_submitted_answers_affect_stats_and_no_confidence_is_stored(self):
        s = self.store.create_session({"mode":"topic","count":1})
        s = self.act(s,"save_answer",text="Грешен")
        self.assertEqual(sum(r["total"] for r in self.store.summary()["stats"]["categories"].values()),0)
        s = self.act(s,"next",text="Грешен",confidence="know")
        self.assertNotIn("confidence",s["answers"][0])
        self.assertEqual(sum(r["total"] for r in self.store.summary()["stats"]["categories"].values()),1)


class AcceptanceTests(unittest.TestCase):
    setUp = StoreTests.setUp
    act = StoreTests.act

    def marathon(self, text='42', completed=False):
        session=self.store.create_session({'mode':'topic','count':1})
        session['questions']=[next(q for q in self.store.questions() if q['id']=='seed-sport-01')]
        with self.store.db() as db: self.store.put_state(db,'sessions',session)
        session=self.act(session,'next',text=text)
        return self.act(session,'next_round') if completed else session

    def test_acceptance_updates_result_bank_retry_and_future_automatic_checks(self):
        session=self.marathon()
        self.assertFalse(session['answers'][0]['correct'])
        self.assertIn('seed-sport-01',self.store.summary()['missed_ids'])
        session=self.act(session,'accept_answer',index=0,text='untrusted replacement')
        self.assertTrue(session['answers'][0]['correct'])
        self.assertTrue(session['answers'][0]['variant_saved'])
        self.assertTrue(session['answers'][0]['accepted_at'])
        self.assertIn('42',session['questions'][0]['alternatives'])
        bank=next(q for q in self.store.questions() if q['id']=='seed-sport-01')
        self.assertEqual(bank['answer'],'42,195 км')
        self.assertIn('42',bank['alternatives'])
        self.assertNotIn('untrusted replacement',bank['alternatives'])
        self.assertTrue(bank['source_url'])
        self.assertNotIn('seed-sport-01',self.store.summary()['missed_ids'])
        self.assertEqual(self.store.summary()['stats']['categories']['sport'],{'total':1,'correct':1})
        restored=server.Store(self.temp.name)
        self.assertEqual(restored.state('sessions',session['id']),session)
        self.assertTrue(self.marathon()['answers'][0]['correct'])

    def test_completed_game_can_be_corrected_without_changing_other_history(self):
        older=self.marathon(completed=True)
        current=self.marathon(completed=True)
        accepted=self.act(current,'accept_answer',index=0)
        self.assertEqual(accepted['status'],'completed')
        self.assertEqual(server.session_brief(accepted)['correct'],1)
        self.assertEqual(self.store.state('sessions',older['id']),older)
        self.assertEqual(self.store.summary()['stats']['completed'],2)

    def test_stale_duplicate_and_normalized_variants_cannot_add_duplicates(self):
        first=self.marathon()
        second=self.marathon('42!')
        accepted=self.act(first,'accept_answer',index=0)
        with self.assertRaises(server.AppError): self.act(first,'accept_answer',index=0)
        with self.assertRaises(server.AppError): self.act(accepted,'accept_answer',index=0)
        self.act(second,'accept_answer',index=0)
        bank=next(q for q in self.store.questions() if q['id']=='seed-sport-01')
        self.assertEqual(sum(server.normalize_answer(a)=='42' for a in bank['alternatives']),1)

    def test_blank_invalid_and_unsubmitted_answers_cannot_be_accepted(self):
        playing=self.store.create_session({'mode':'topic','count':1})
        with self.assertRaises(server.AppError): self.act(playing,'accept_answer',index=0)
        for text in ('','  ','...'):
            session=self.marathon(text)
            with self.assertRaises(server.AppError): self.act(session,'accept_answer',index=0)
        session=self.marathon()
        for target in (-1,1,True,'0',None):
            with self.subTest(target=target),self.assertRaises(server.AppError): self.act(session,'accept_answer',index=target)

    def test_changed_or_deleted_bank_question_is_not_recreated_or_taught(self):
        session=self.marathon()
        question=session['questions'][0]
        self.store.update_question(question['id'],{**question,'answer':'Променен отговор'})
        accepted=self.act(session,'accept_answer',index=0)
        self.assertTrue(accepted['answers'][0]['correct'])
        self.assertFalse(accepted['answers'][0]['variant_saved'])
        bank=next(q for q in self.store.questions() if q['id']==question['id'])
        self.assertNotIn('42',bank['alternatives'])
        self.store.delete_question(question['id'])
        session2=self.store.create_session({'mode':'topic','count':1})
        session2['questions']=[question]
        with self.store.db() as db:self.store.put_state(db,'sessions',session2)
        session2=self.act(session2,'next',text='42')
        accepted=self.act(session2,'accept_answer',index=0)
        self.assertFalse(accepted['answers'][0]['variant_saved'])
        self.assertNotIn(question['id'],{q['id'] for q in self.store.questions()})

    def test_bank_and_result_changes_roll_back_together_on_failure(self):
        import sqlite3
        from unittest.mock import patch
        session=self.marathon()
        with patch.object(self.store,'put_state',side_effect=sqlite3.OperationalError('simulated failure')):
            with self.assertRaises(sqlite3.OperationalError):self.act(session,'accept_answer',index=0)
        self.assertEqual(self.store.state('sessions',session['id']),session)
        bank=next(q for q in self.store.questions() if q['id']=='seed-sport-01')
        self.assertNotIn('42',bank['alternatives'])

    def test_long_submitted_variants_remain_editable_and_valid(self):
        text='Моят отговор '+ 'а'*700
        session=self.marathon(text)
        self.act(session,'accept_answer',index=0)
        bank=next(q for q in self.store.questions() if q['id']=='seed-sport-01')
        self.assertIn(text,bank['alternatives'])
        self.store.update_question(bank['id'],bank)


class VisualPackTests(unittest.TestCase):
    setUp = StoreTests.setUp

    def test_pack_has_200_unique_questions_and_two_visuals_per_category(self):
        from seed import QUESTIONS
        from collections import Counter
        self.assertEqual(len(QUESTIONS),480)
        self.assertEqual(len({server.fingerprint(q['prompt']) for q in QUESTIONS}),480)
        self.assertEqual(len(server.CATEGORIES),16)
        self.assertEqual(Counter(q['category'] for q in QUESTIONS if q.get('image')),{c:2 for c in server.CATEGORIES})
        self.assertEqual(self.store.summary()['stats']['visual'],32)

    def test_every_local_image_exists_matches_its_hash_and_has_attribution(self):
        import hashlib
        import xml.etree.ElementTree as ET
        self.assertEqual(len(server.MEDIA),32)
        for media in server.MEDIA.values():
            path=server.ROOT/'static'/media['path'].lstrip('/')
            raw=path.read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(),media['sha256'])
            self.assertTrue(media['credit'])
            self.assertTrue(media['license'])
            if path.suffix=='.svg':
                root=ET.fromstring(raw)
                self.assertTrue(root.tag.endswith('svg'))
                self.assertNotIn(b'<script',raw)
            else:
                self.assertTrue(raw.startswith(b'\xff\xd8'))
                self.assertTrue(media['source_url'].startswith('https://commons.wikimedia.org/'))

    def test_each_category_can_start_a_quiz_with_a_visual_question(self):
        for category in server.CATEGORIES:
            with self.subTest(category=category):
                session=self.store.create_session({'mode':'topic','categories':[category],'count':5})
                self.assertTrue(any(q.get('image') for q in session['questions']))
                self.assertTrue(all(q['category']==category for q in session['questions']))
                self.assertEqual(len({q['id'] for q in session['questions']}),5)

    def test_upgrade_adds_only_new_pack_and_preserves_edits_deletions_and_games(self):
        from seed import QUESTIONS
        original=[q for q in QUESTIONS if q.get('pack_version')!=4]
        removed=original[0]['id']
        edited=original[1]
        self.store.delete_question(removed)
        self.store.update_question(edited['id'],{**edited,'answer':'Моята редакция'})
        game=self.store.create_session({'mode':'topic','count':5})
        with self.store.db() as db:
            db.executemany('DELETE FROM questions WHERE id=?',[(q['id'],) for q in QUESTIONS if q.get('pack_version',1)>=4])
            db.execute('ALTER TABLE questions DROP COLUMN image')
            db.execute('PRAGMA user_version=3')
        restored=server.Store(self.temp.name)
        bank={q['id']:q for q in restored.questions()}
        self.assertEqual(len(bank),479)
        self.assertNotIn(removed,bank)
        self.assertEqual(bank[edited['id']]['answer'],'Моята редакция')
        self.assertEqual(restored.state('sessions',game['id']),game)
        visual=next(q for q in bank.values() if q.get('image'))
        restored.delete_question(visual['id'])
        self.assertEqual(len(server.Store(self.temp.name).questions()),478)

    def test_visual_edit_and_answer_check_keep_the_image_snapshot(self):
        q=next(q for q in self.store.questions() if q.get('image'))
        self.store.update_question(q['id'],{**q,'answer':'Редакция'})
        edited=next(x for x in self.store.questions() if x['id']==q['id'])
        self.assertEqual(edited['image'],q['image'])
        with self.assertRaises(server.AppError):
            self.store.update_question(q['id'],{**q,'image':{'path':'https://outside.example/picture.jpg'}})
        with self.assertRaises(server.AppError):
            self.store.update_question(q['id'],{**q,'image':{'path':'/media/../../data/quiz.sqlite3'}})


class AnswerTests(unittest.TestCase):
    def test_all_curated_answers_and_declared_alternatives_are_accepted(self):
        from seed import QUESTIONS
        for q in QUESTIONS:
            for text in [q["answer"],*q["alternatives"]]:
                with self.subTest(question=q["id"],text=text):
                    self.assertTrue(server.check_answer(q,text))
                    self.assertTrue(server.check_answer(q,"  „"+text.upper()+"“!  "))

    def test_case_spacing_quotes_and_hyphens(self):
        q = {"answer":"Антоан дьо Сент-Екзюпери","alternatives":["Сент-Екзюпери"]}
        for text in ("АНТОАН  ДЬО   СЕНТ ЕКЗЮПЕРИ", "„Сент–Екзюпери“. ", "сент-екзюпери"):
            with self.subTest(text=text): self.assertTrue(server.check_answer(q,text))
        for text in ("", "  ", "...", "Не е Сент-Екзюпери", "Сент-Екзюпери или Вазов", "Екзюпери"):
            with self.subTest(text=text): self.assertFalse(server.check_answer(q,text))

    def test_numbers_do_not_lose_decimal_places_or_signs(self):
        q = {"answer":"42,195 км","alternatives":["42,195"]}
        self.assertTrue(server.check_answer(q,"42.195 км."))
        for text in ("42195", "42", "42.196", "-42.195", "42 195"):
            with self.subTest(text=text): self.assertFalse(server.check_answer(q,text))
        self.assertFalse(server.check_answer({"answer":"1969","alternatives":[]},"1968"))
        self.assertFalse(server.check_answer({"answer":"8","alternatives":[]},"-8"))
        self.assertNotEqual(server.normalize_answer("1/2"),server.normalize_answer("12"))


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.server = server.make_server(cls.temp.name,0)
        cls.thread = threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.client = build_opener(ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(); cls.temp.cleanup()

    def request(self,path,method="GET",data=None,headers=None):
        request = Request(self.base+path, data=json.dumps(data).encode() if data is not None else None,method=method,headers=headers or ({"Content-Type":"application/json"} if data is not None else {}))
        try:
            with self.client.open(request,timeout=3) as result: return result.status,result.headers,result.read()
        except HTTPError as error: return error.code,error.headers,error.read()

    def test_http_round_trip_and_static_content(self):
        status,headers,body = self.request("/")
        self.assertEqual(status,200)
        self.assertIn("Куиз Загрявка",body.decode())
        self.assertIn("frame-ancestors 'none'",headers["Content-Security-Policy"])
        self.assertIn('/fonts/InterVariable.woff2',body.decode())
        self.assertEqual(self.request('/theme.js')[0],200)
        status,font_headers,font = self.request("/fonts/InterVariable.woff2")
        self.assertEqual(status,200)
        self.assertEqual(font_headers["Content-Type"],"font/woff2")
        self.assertTrue(font.startswith(b"wOF2"))
        self.assertEqual(self.request("/fonts/../server.py")[0],404)
        status,_,body = self.request("/api/sessions","POST",{"mode":"quick","timer_seconds":0})
        self.assertEqual(status,201)
        identity = json.loads(body)["id"]
        self.assertEqual(self.request("/api/sessions/"+identity)[0],200)

    def test_accept_answer_http_round_trip(self):
        _,_,body=self.request('/api/sessions','POST',{'mode':'topic','count':1})
        session=json.loads(body)
        path='/api/sessions/'+session['id']
        _,_,body=self.request(path,'PATCH',{'action':'next','revision':session['revision'],'question_index':0,'text':'Моят нов вариант'})
        session=json.loads(body)
        status,_,body=self.request(path,'PATCH',{'action':'accept_answer','revision':session['revision'],'index':0})
        self.assertEqual(status,200)
        accepted=json.loads(body)
        self.assertTrue(accepted['answers'][0]['correct'])
        self.assertIn('Моят нов вариант',accepted['questions'][0]['alternatives'])

    def test_only_registered_media_assets_are_served(self):
        for media in server.MEDIA.values():
            status,headers,body=self.request(media['path'])
            self.assertEqual(status,200)
            self.assertEqual(headers['Content-Type'],'image/svg+xml' if media['path'].endswith('.svg') else 'image/jpeg')
            self.assertTrue(body)
        for path in ('/media/credits.json','/media/v99.jpg','/media/../server.py','/media/%2e%2e/data/quiz.sqlite3'):
            self.assertEqual(self.request(path)[0],404)

    def test_question_delete_endpoint_removes_question_and_guards_origin(self):
        _,_,body = self.request("/api/questions")
        question = json.loads(body)["questions"][0]
        path = "/api/questions/"+question["id"]
        self.assertEqual(self.request(path,"PUT",{**question,"answer":"Редактиран отговор"})[0],200)
        self.assertEqual(self.request(path,"DELETE",{}, {"Content-Type":"application/json","Origin":"https://outside.example"})[0],403)
        self.assertEqual(self.request(path,"DELETE")[0],200)
        self.assertEqual(self.request(path,"DELETE",{})[0],404)
        _,_,body = self.request("/api/questions")
        questions = json.loads(body)["questions"]
        self.assertNotIn(question["id"],{q["id"] for q in questions})
        self.assertTrue(all("status" not in q for q in questions))

    def test_origin_host_and_content_type_guards(self):
        self.assertEqual(self.request("/api/sessions","POST",{}, {"Content-Type":"application/json","Origin":"https://outside.example"})[0],403)
        self.assertEqual(self.request("/api/bootstrap",headers={"Host":"outside.example"})[0],403)
        self.assertEqual(self.request("/api/sessions","POST",{}, {"Content-Type":"text/plain"})[0],415)
        self.assertEqual(self.request("/data/quiz.sqlite3")[0],404)
        self.assertEqual(self.request("/../server.py")[0],404)

    def test_removed_endpoints_are_unavailable_and_bank_play_is_independent(self):
        for path,method,data in (("/api/ollama","GET",None),("/api/jobs","POST",{}),("/api/jobs/"+"a"*32,"GET",None),("/api/jobs/"+"a"*32,"POST",{}),("/api/settings","PUT",{})):
            with self.subTest(path=path,method=method): self.assertEqual(self.request(path,method,data)[0],404)
        status,_,body = self.request("/api/bootstrap")
        self.assertEqual(status,200)
        self.assertNotIn("jobs",json.loads(body))
        self.assertNotIn("settings",json.loads(body))
        self.assertEqual(self.request("/api/sessions","POST",{})[0],201)


if __name__ == "__main__":
    unittest.main()


class HistoryDeletionTests(unittest.TestCase):
    setUp=StoreTests.setUp
    act=StoreTests.act
    finish_round=StoreTests.finish_round
    def test_deletion_recomputes_stats_and_latest_missed(self):
        s=self.finish_round(self.store.create_session({'mode':'topic','count':1}),correct=False)
        self.assertEqual(self.store.summary()['stats']['completed'],1)
        self.store.delete_session(s['id'])
        stats=self.store.summary()['stats']
        self.assertEqual(stats['completed'],0)
        self.assertEqual(stats['missed'],0)
        self.assertEqual(sum(x['total'] for x in stats['categories'].values()),0)
    def test_every_category_difficulty_has_ten(self):
        from collections import Counter
        counts=Counter((q['category'],q['difficulty']) for q in self.store.questions())
        self.assertEqual(len(counts),48)
        self.assertTrue(all(n>=10 for n in counts.values()))
