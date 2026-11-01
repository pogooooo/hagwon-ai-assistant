from pathlib import Path
import json, collections, datetime, sys
root=Path(__file__).resolve().parent
load=lambda n: [json.loads(s) for s in (root/n).read_text(encoding='utf-8').splitlines() if s.strip()]
docs=load('corpus.jsonl'); facts=load('facts.jsonl'); cases=load('cases.jsonl');users=json.loads((root/'users.json').read_text(encoding='utf-8'))
D={d['document_id']:d for d in docs};F={f['fact_id']:f for f in facts};U={u['user_id']:u for u in users}
errors=[]
def ck(condition,message):
 if not condition:errors.append(message)
for f in facts:
 ck(f['document_id'] in D, f"unknown source {f['fact_id']}")
 if f['document_id'] in D:
  d=D[f['document_id']];ck(f['source_id']==d['source_id'],f"wrong source id {f['fact_id']}")
  ck(f['academy_id']==d['academy_id'],f"wrong academy {f['fact_id']}")
  ck(f['fact_id'] in d['fact_ids'],f"fact missing from doc {f['fact_id']}")
seen=set();groups=collections.defaultdict(set)
for c in cases:
 id=c['case_id']; ck(id not in seen, f"duplicate case {id}");seen.add(id)
 ck(c['input']['user_id'] in U, f"invalid user {id}")
 groups[c['scenario_group']].add(c['split'])
 e=c['expected'];ck(len(e['fact_ids'])==len(e['source_ids']),f"source count mismatch {id}")
 ck(e['status'] in ('answered','partial','abstained','clarify','denied','handoff'),f"invalid status {id}")
 for fid,sid in zip(e['fact_ids'],e['source_ids']):
  ck(fid in F,f"invalid fact reference {id} {fid}")
  if fid not in F:continue
  f=F[fid];ck(f['source_id']==sid,f"mismatched citation {id}")
  u=U.get(c['input']['user_id'],{})
  ck(f['academy_id']==u.get('academy_id'),f"cross academy reference {id}")
  if f['subject_type']=='student': ck(f['subject_id'] in u.get('allowed_student_ids',[]),f"student acl violation {id}")
  d=D[f['document_id']];ck(d['status']=='approved_active',f"draft fact cited {id}")
  when=datetime.datetime.fromisoformat(c['input']['as_of']);beg=datetime.datetime.fromisoformat(f['valid_from']);end=datetime.datetime.fromisoformat(f['valid_to']) if f['valid_to'] else None
  ck(when>=beg and (end is None or when<end or ('historical_comparison' in c['tags'] and f['fact_type']=='monthly_fee')),f"out of effective interval {id}, {fid}")
 ck(e['generation_budget_max'] in (0,1),f"invalid generation budget {id}")
for group,splits in groups.items():ck(len(splits)==1,f"split leakage {group}: {splits}")
print('cases:',len(cases),'docs:',len(docs),'facts:',len(facts),'users:',len(users))
print('categories:',dict(collections.Counter(c['category'] for c in cases)))
print('splits:',dict(collections.Counter(c['split'] for c in cases)))
print('validation:', 'PASS' if not errors else 'FAILED', len(errors),'errors')
for e in errors[:30]:print(' -',e)
sys.exit(0 if not errors else 1)
