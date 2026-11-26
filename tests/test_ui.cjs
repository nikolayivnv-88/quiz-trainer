// Controller regression tests, without a browser or external dependencies.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture() {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector,{innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,readOnly:false,showModal(){this.open=true;},close(){this.open=false;},classList:{toggle(){},add(){},remove(){}},focus(){},setAttribute(){},removeAttribute(){}});
    return nodes.get(selector);
  };
  let intervals = 0;
  const handlers={};
  const context = vm.createContext({console,URL,Intl,Date,Promise,JSON,Math,Number,String,Array,Object,Set,RegExp,Error,
    document:{querySelector:node,querySelectorAll:()=>[],addEventListener(name,handler){handlers[name]=handler;}},
    window:{addEventListener(){},scrollTo(){}},location:{hash:'#/'},
    setTimeout:()=>1,clearTimeout(){},setInterval(){intervals++;return intervals;},clearInterval(){},
    fetch:async()=>{throw Error('Unexpected request');}
  });
  const source = fs.readFileSync(path.join(__dirname,'../static/app.js'),'utf8').replace(/\nboot\(\);\s*$/,'');
  vm.runInContext(source,context);
  const ui = vm.runInContext('({state,game,review,saveDraft,submitAnswer,setDraft,updateAvailability,libraryResults,escapeHTML,config,home,startTraining,handleAnswerKeydown,acceptAnswer,reviewItem,openReviewDetails,questionImage,confirmQuestionDeletion,deleteQuestion,history,results,openEditor})',context);
  ui.state.data = {categories:{history:'История'},difficulties:{medium:'Средно'},modes:{quick:'Бърза загрявка'},stats:{missed:1,bank:1,completed:0,categories:{history:{total:0,correct:0}}},sessions:[],missed_ids:['q1']};
  ui.state.questions = [{id:'q1',category:'history',difficulty:'medium',prompt:'Тестов въпрос?',answer:'DO_NOT_REVEAL',alternatives:[],explanation:'SECRET_EXPLANATION',origin:'seed',source_url:null}];
  ui.state.categories = ['history'];
  ui.state.session = {id:'a'.repeat(32),mode:'quick',name:'Тестова игра',status:'playing',index:0,questions:[ui.state.questions[0],{...ui.state.questions[0],id:'q2'}],answers:[{text:'',correct:null},{text:'',correct:null}],revision:0};
  ui.setDraft();
  return {context,ui,node,handlers,intervals:()=>intervals};
}

test('untimed play schedules no countdown and conceals answers until review',()=>{
  const {ui,node,intervals}=fixture();
  ui.game();
  assert.doesNotMatch(node('#main').innerHTML,/timer|таймер|Оставащо време/);
  assert.doesNotMatch(node('#main').innerHTML,/DO_NOT_REVEAL|SECRET_EXPLANATION/);
  assert.equal(intervals(),0);
  ui.state.session.status='review';ui.state.session.index=1;ui.state.session.answers[0].correct=true;ui.state.session.answers[1].correct=false;ui.review();
  assert.match(node('#main').innerHTML,/DO_NOT_REVEAL/);
  ui.openReviewDetails(0); assert.match(node('#review-details').innerHTML,/SECRET_EXPLANATION/);
  assert.match(node('#main').innerHTML,/1\/2 верни отговора/);
  assert.match(node('#main').innerHTML,/verdict-card correct/);
  assert.match(node('#main').innerHTML,/verdict-card wrong/);
  assert.doesNotMatch(node('#main').innerHTML,/data-action="grade"|data-action="next-round" disabled/);
});

test('question and answer text are escaped when rendering the library',()=>{
  const {ui,node}=fixture();
  ui.state.questions[0].prompt='<img src=x onerror=alert(1)>';
  ui.state.questions[0].answer='<script>bad()</script>';
  ui.libraryResults();
  const html=node('#library-results').innerHTML;
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  assert.doesNotMatch(html,/<script>|<img src=x/);
});

test('retry availability applies category filters rather than global missed count',()=>{
  const {ui,node}=fixture();
  ui.state.mode='retry';ui.state.categories=['science'];
  ui.updateAvailability();
  assert.equal(node('#start-button').disabled,true);
  assert.match(node('#availability').textContent,/До 0/);
});

test('autosave and submission serialize revisions and target the same question',async()=>{
  const {ui,context}=fixture();
  let backend=JSON.parse(JSON.stringify(ui.state.session));
  const requests=[];
  context.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);
    assert.equal(body.revision,backend.revision);
    assert.equal(body.question_index,backend.index);
    backend.answers[backend.index].text=body.text;
    assert.equal("confidence" in body,false);
    if(body.action==='next')backend.index++;
    backend.revision++;
    return {ok:true,json:async()=>JSON.parse(JSON.stringify(backend))};
  };
  ui.state.draft.text='Първи отговор';ui.state.draft.dirty=true;
  const saving=ui.saveDraft();
  ui.state.draft.text='Окончателен отговор';
  const submitting=ui.submitAnswer();
  await Promise.all([saving,submitting]);
  assert.deepEqual(requests.map(r=>r.action),['save_answer','next']);
  assert.deepEqual(requests.map(r=>r.revision),[0,1]);
  assert.equal(backend.answers[0].text,'Окончателен отговор');
  assert.equal(ui.state.session.index,1);
  assert.equal(ui.state.draft.text,'');
});

test('visibility autosave during submission cannot submit a stale draft to the next question',async()=>{
  const {ui,context}=fixture();
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const requests=[];
  context.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);
    await gate;
    const next=JSON.parse(JSON.stringify(ui.state.session));next.index=1;next.revision++;
    return {ok:true,json:async()=>next};
  };
  ui.state.draft.text='Отговор';ui.state.draft.dirty=true;
  const submitting=ui.submitAnswer();
  const saving=ui.saveDraft();
  release();await Promise.all([submitting,saving]);
  assert.equal(requests.length,1);
  assert.equal(requests[0].action,'next');
  assert.equal(requests[0].question_index,0);
});


test('setup only offers bank questions and sends a small untimed configuration',async()=>{
  const {ui,node,context}=fixture();
  ui.home();
  const html=node('#main').innerHTML;
  assert.doesNotMatch(html,/Ollama|AI|таймер|data-action="source"|include-ai|settings/);
  const requests=[];
  context.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({id:'b'.repeat(32)})};};
  await ui.startTraining();
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'/api/sessions');
  assert.deepEqual(Object.keys(requests[0].body).sort(),['categories','count','difficulty','mode']);
});

test('question statuses and confidence are absent from every screen',()=>{
  const {ui,node}=fixture();
  ui.game();
  assert.doesNotMatch(node('#main').innerHTML,/confidence|Колко сте уверени|Налучкваме|Предполагаме/);
  ui.libraryResults();
  assert.match(node('#library-results').innerHTML,/data-action="delete-question"/);
  assert.doesNotMatch(node('#library-results').innerHTML,/question-status|Одобри|Изключи/);
  ui.openEditor('q1');
  assert.doesNotMatch(node('#editor').innerHTML,/edit-status|Одобр/);
  ui.history();
  assert.doesNotMatch(node('#main').innerHTML,/уверен|Колко си вярваме|confidence/);
  ui.state.session.answers.forEach(a=>a.correct=false);
  ui.state.session.created_at='2026-11-24T18:00:00Z';
  ui.results();
  assert.doesNotMatch(node('#main').innerHTML,/Увереност|confidentWrong|confidence/);
});

function enterEvent(overrides={}) {
  return {target:{id:'answer'},key:'Enter',preventDefault(){this.prevented=true;},...overrides};
}

test('Enter submits once even with a concurrent click or held key',async()=>{
  const {ui,context,handlers}=fixture();
  assert.equal(handlers.keydown,ui.handleAnswerKeydown);
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const requests=[];
  context.fetch=async(url,options)=>{
    requests.push(JSON.parse(options.body));
    await gate;
    const next=JSON.parse(JSON.stringify(ui.state.session));next.index=1;next.revision++;
    return {ok:true,json:async()=>next};
  };
  ui.state.draft.text='Отговор с Enter';
  const event=enterEvent();
  const submitting=ui.handleAnswerKeydown(event);
  assert.equal(event.prevented,true);
  await ui.submitAnswer();
  ui.handleAnswerKeydown(enterEvent({repeat:true}));
  release();await submitting;
  assert.equal(requests.length,1);
  assert.equal(requests[0].text,'Отговор с Enter');
  assert.equal(requests[0].question_index,0);
  assert.equal('confidence' in requests[0],false);
  assert.equal(ui.state.session.index,1);
  ui.handleAnswerKeydown(enterEvent({repeat:true}));
  assert.equal(requests.length,1);
});

test('Shift+Enter, composition and Enter in other fields do not submit',()=>{
  const {ui}=fixture();
  for(const overrides of [{shiftKey:true},{ctrlKey:true},{isComposing:true},{target:{id:'library-search'}},{key:'a'}]) {
    const event=enterEvent(overrides);
    assert.equal(ui.handleAnswerKeydown(event),undefined);
    assert.equal(event.prevented,undefined);
    assert.equal(ui.state.session.index,0);
  }
});

test('deletion confirmation escapes content and successful deletion refreshes the bank',async()=>{
  const {ui,node,context}=fixture();
  ui.state.questions[0].prompt='<img src=x onerror=alert(1)>';
  ui.confirmQuestionDeletion('q1');
  assert.equal(node('#delete-question').open,true);
  assert.match(node('#delete-question').innerHTML,/&lt;img/);
  assert.doesNotMatch(node('#delete-question').innerHTML,/<img/);
  const calls=[];
  context.fetch=async(url,options)=>{
    calls.push([url,options.method]);
    return {ok:true,json:async()=>url==='/api/bootstrap'?ui.state.data:url==='/api/questions'?{questions:[]}:{ok:true}};
  };
  await ui.deleteQuestion('q1');
  assert.deepEqual(calls[0],['/api/questions/q1','DELETE']);
  assert.equal(ui.state.questions.length,0);
  assert.equal(node('#delete-question').open,false);
  assert.match(node('#toast').textContent,/изтрит/);
});


test('visual questions show the image during play and reveal credit only after the round',()=>{
  const {ui,node}=fixture();
  ui.state.questions[0].image={path:'/media/v31.jpg',credit:'SECRET_CREATOR',license:'Public domain',source_url:'https://example.com/SECRET_SUBJECT',changes:'Resized'};
  ui.game();
  assert.match(node('#main').innerHTML,/<img src="\/media\/v31.jpg"/);
  assert.match(node('#main').innerHTML,/loading="eager"/);
  assert.doesNotMatch(node('#main').innerHTML,/SECRET_CREATOR|SECRET_SUBJECT|DO_NOT_REVEAL|figcaption/);
  ui.state.session.status='review';ui.state.session.index=1;
  ui.review();
  ui.openReviewDetails(0); assert.match(node('#review-details').innerHTML,/SECRET_CREATOR/);
  assert.match(node('#review-details').innerHTML,/SECRET_SUBJECT/);
  assert.match(node('#main').innerHTML,/DO_NOT_REVEAL/);
});

test('visual and text filters combine with category and search filters',()=>{
  const {ui,node}=fixture();
  ui.state.questions.push({...ui.state.questions[0],id:'q3',prompt:'Визуален въпрос',image:{path:'/media/v04.svg',credit:'Автор',license:'Схема'}});
  ui.state.library.kind='visual';ui.libraryResults();
  assert.match(node('#library-results').innerHTML,/1 намерени/);
  assert.match(node('#library-results').innerHTML,/Визуален въпрос/);
  assert.doesNotMatch(node('#library-results').innerHTML,/Тестов въпрос/);
  ui.state.library.kind='text';ui.libraryResults();
  assert.doesNotMatch(node('#library-results').innerHTML,/Визуален въпрос/);
  ui.state.library.category='science';ui.libraryResults();
  assert.match(node('#library-results').innerHTML,/0 намерени/);
});

test('image rendering rejects remote and traversal paths and escapes credits',()=>{
  const {ui}=fixture();
  for(const path of ['https://outside.example/image.jpg','/media/../../server.py','/media/v01.jpg" onerror="alert(1)'])
    assert.equal(ui.questionImage({image:{path}}), '');
  const html=ui.questionImage({image:{path:'/media/v01.jpg',credit:'<img src=x>',license:'Test',source_url:'javascript:alert(1)'}},true);
  assert.match(html,/&lt;img src=x&gt;/);
  assert.doesNotMatch(html,/href="javascript:/);
});


test('compact review offers acceptance for wrong answers in review and completed results',()=>{
  const {ui,node}=fixture();
  ui.state.session.answers[0]={text:'42',correct:false};
  ui.state.session.answers[1]={text:'Correct',correct:true};
  ui.state.session.index=1;ui.state.session.status='review';
  ui.review();
  const html=node('#main').innerHTML;
  assert.equal((html.match(/data-action="accept-answer"/g)||[]).length,2);
  assert.match(html,/data-index="0"/);
  assert.match(html,/data-action="review-details"/);
  assert.doesNotMatch(html,/<details/);
  ui.state.session.status='completed';ui.state.session.created_at='2026-11-24T18:00:00Z';
  ui.results();
  assert.match(node('#main').innerHTML,/Приеми за верен/);
  ui.state.session.answers[0].text='';ui.results();
  assert.match(node('#main').innerHTML,/data-index="0" disabled/);
});

test('acceptance sends only the stored answer index, refreshes stats and updates the score',async()=>{
  const {ui,context,node}=fixture();
  ui.state.session.status='completed';ui.state.session.created_at='2026-11-24T18:00:00Z';
  ui.state.session.answers[0]={text:'42',correct:false};
  ui.state.session.answers[1]={text:'Correct',correct:true};
  const requests=[];
  context.fetch=async(url,options)=>{
    if(options.method==='PATCH') {
      const body=JSON.parse(options.body);requests.push(body);
      const s=JSON.parse(JSON.stringify(ui.state.session));s.answers[0].correct=true;s.answers[0].accepted_at='2026-11-24';s.answers[0].variant_saved=true;s.revision++;
      return {ok:true,json:async()=>s};
    }
    return {ok:true,json:async()=>url==='/api/bootstrap'?{...ui.state.data,stats:{...ui.state.data.stats,missed:0}}:{questions:ui.state.questions}};
  };
  await Promise.all([ui.acceptAnswer(0),ui.acceptAnswer(0)]);
  assert.equal(requests.length,1);
  assert.deepEqual(requests[0],{action:'accept_answer',revision:0,index:0});
  assert.equal(ui.state.session.answers[0].correct,true);
  assert.equal(ui.state.data.stats.missed,0);
  assert.match(node('#main').innerHTML,/data-index="0" disabled/);
  assert.match(node('#main').innerHTML,/Приет/);
  assert.match(node('#main').innerHTML,/100%/);
  assert.equal(ui.state.busy,false);
});

test('failed acceptance leaves the answer wrong and releases the busy flag',async()=>{
  const {ui,context}=fixture();
  ui.state.session.status='review';ui.state.session.answers[0]={text:'42',correct:false};
  context.fetch=async()=>({ok:false,json:async()=>({error:'Неуспешен запис'})});
  await assert.rejects(ui.acceptAnswer(0),/Неуспешен запис/);
  assert.equal(ui.state.session.answers[0].correct,false);
  assert.equal(ui.state.busy,false);
});


test('completed results omit categories that were not played',()=>{
  const {ui,node}=fixture();
  ui.state.data.categories.science='Наука';
  ui.state.session.status='completed';ui.state.session.created_at='2026-11-24T18:00:00Z';
  ui.state.session.answers.forEach(a=>a.correct=true);
  ui.results();
  assert.match(node('#main').innerHTML,/История/);
  assert.doesNotMatch(node('#main').innerHTML,/Наука/);
});
