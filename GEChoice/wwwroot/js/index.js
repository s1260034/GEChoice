// const conn=new signalR.HubConnectionBuilder().withUrl("/hub/vote",{transport:signalR.HttpTransportType.LongPolling}).withAutomaticReconnect().build();
const conn=new signalR.HubConnectionBuilder()
.withUrl("/hub/vote",{
    transport:signalR.HttpTransportType.WebSockets,
})
.withAutomaticReconnect()
.build();

const qTitle=document.getElementById('q-title');
const qNum=document.getElementById('q-num');
const optsDiv=document.getElementById('opts');
const clientStatusDiv=document.getElementById('client-status');
const participantsDiv=document.getElementById('participants');
const questionResultsDiv=document.getElementById('question-results');
const votingStatusDiv=document.getElementById('voting-status');
const timerDiv=document.getElementById('timer');
const answerBtn=document.getElementById('show-result');
const startBtn=document.getElementById('start-voting');
const stopBtn=document.getElementById('stop-voting');
const prevBtn=document.getElementById('prev');
const nextBtn=document.getElementById('next');
const interimDiv=document.getElementById('interim-totals');

let currentState=null, questionResults={}, joinUrl=window.joinUrlFromServer || "http://192.168.10.2:8080/vote", qr=null;

// 受付/確定フラグ（表示制御の一元管理）
let isVotingOpenFlag=false;
let hasSnapshotForThisQuestion=false;

// タイマー（表示用）
let timerInterval=null, timerStartMs=0;
function startTimer(){ if(timerInterval) return; timerStartMs=Date.now(); timerDiv.style.display='block'; timerDiv.textContent='0秒';
  timerInterval=setInterval(()=>{ const sec=Math.floor((Date.now()-timerStartMs)/1000); timerDiv.textContent=`${sec}秒`; },200); }
function stopTimer(){ if(!timerInterval) return; clearInterval(timerInterval); timerInterval=null; timerDiv.style.display='none'; timerDiv.textContent='0秒'; }

// QR
const joinLink=document.getElementById('join-link');
const qrModal=document.getElementById('qr-modal');
const showQrModalBtn=document.getElementById('show-qr-modal');
joinLink.textContent=joinUrl; joinLink.href=joinUrl;
showQrModalBtn.onclick=()=>{ if(!qr) qr=new QRious({element:document.getElementById('qr'),value:joinUrl,size:250}); qrModal.style.display='block'; };
qrModal.onclick=e=>{ if(e.target===qrModal) qrModal.style.display='none'; };
document.getElementById('edit-url').onclick=()=>{ const v=prompt("参加URLを入力",joinUrl)||joinUrl; joinUrl=v; if(qr) qr.set({value:joinUrl}); joinLink.textContent=joinUrl; joinLink.href=joinUrl; };

/* ===== 「回答一覧/最終結果」ボタン表示制御 ===== */
function refreshAnswerBtn(){
  if(!answerBtn || !currentState) return;
  const idx=currentState.currentIndex||0;
  const total=currentState.totalQuestions||1;
  const isLast = idx===total-1;

  // 表示条件：受付停止中 かつ スナップショット有り
  const shouldShow = (!isVotingOpenFlag && hasSnapshotForThisQuestion);
  answerBtn.style.display = shouldShow ? 'inline-block' : 'none';
  answerBtn.disabled = false;

  if(isLast){
    answerBtn.textContent='最終結果';
    answerBtn.title = shouldShow ? '' : '最後の問題を「回答終了」してから表示できます';
    answerBtn.onclick=()=>conn.invoke('GetGameResults');
  }else{
    answerBtn.textContent='回答一覧';
    answerBtn.title = shouldShow ? '' : 'この問題を「回答終了」してから表示できます';
    answerBtn.onclick=()=>conn.invoke('ShowQuestionResults');
  }
}

/* ===== Hub受信 ===== */
conn.on("StateUpdated", s=>{
  currentState=s;
  // フラグ更新
  isVotingOpenFlag = !!s.isVotingOpen;
  hasSnapshotForThisQuestion = !!questionResults[s.currentIndex||0];
  render(s);
  refreshAnswerBtn();
});

conn.on("ParticipantsUpdated", list=> displayParticipants(list||[]));

conn.on("VotingStatusChanged", isOpen=>{
  isVotingOpenFlag = !!isOpen;
  if(isOpen){
    startBtn.style.display='none'; stopBtn.style.display='inline-block';
    votingStatusDiv.innerHTML='<span class="status-indicator status-open"></span><span>回答受付中</span>';
    startTimer();
    startBtn.disabled = false;
  }else{
    startBtn.style.display='inline-block'; stopBtn.style.display='none';
    votingStatusDiv.innerHTML='<span class="status-indicator status-closed"></span><span>回答受付停止中</span>';
    stopTimer();
    stopBtn.disabled = false;
  }
  nextBtn.disabled = !!isOpen;
  prevBtn.disabled = !!isOpen;
  refreshAnswerBtn();
});

conn.on("QuestionResults",(index,results)=>{
  questionResults[index]=results;
  if(currentState && index===(currentState.currentIndex||0)) hasSnapshotForThisQuestion=true;
  displayQuestionResults(index,results);
  refreshAnswerBtn();
});

conn.on("GameResults", results=> displayFinalResults(results));

conn.on("ShowPerQuestionResults",(index,rows)=>{
  if(currentState && index===(currentState.currentIndex||0)) hasSnapshotForThisQuestion=true;

  const modal=document.getElementById('answer-list-modal');
  const qDiv=document.getElementById('answer-list-question');
  const cDiv=document.getElementById('answer-list-content');
  const title=(currentState?.question?.title)||`問題${index+1}`;

  const groups={A:[],B:[]};
  (rows||[]).forEach(r=>{
    const opt=(r.selectedOption||r.SelectedOption||'-').toUpperCase();
    const team=(r.teamName||r.TeamName||'').trim();
    const mul=r.multiplier||r.Multiplier||1;
    if(!team) return;
    if(opt==='A'||opt==='B') groups[opt].push({team,mul});
  });
  const countA=groups.A.length, countB=groups.B.length;

  document.getElementById('answer-list-title').textContent=`回答一覧（A: ${countA}チーム / B: ${countB}チーム）`;
  qDiv.textContent=title;

  let html='';
  ['A','B'].forEach(opt=>{
    const list=groups[opt];
    html+=`
      <div style="margin-bottom:20px;padding:16px;background:#f9fafb;border-radius:8px;">
        <div style="font-size:18px;font-weight:700;color:#111;margin-bottom:12px;">
          選択肢 ${opt} <span style="font-weight:400;color:#666;">(${list.length}件)</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${list.map(x=>`
            <div style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;">
              <span style="font-weight:600;">${x.team}</span>
              <span style="color:#666;margin-left:8px;">×${x.mul}</span>
            </div>`).join('') || `<div class="no-vote">回答なし</div>`}
        </div>
      </div>`;
  });
  cDiv.innerHTML=html;
  modal.style.display='block';
  refreshAnswerBtn();
});
conn.on("ClosePerQuestionResults",()=>{
  document.getElementById('answer-list-modal').style.display='none';
  refreshAnswerBtn();
});

conn.on("VoteDeleted", ()=>{ conn.invoke("GetState"); });

conn.on("InterimTotalsUpdated", list=>{
  if(!list || list.length===0){
    interimDiv.innerHTML='<p class="muted">回答終了後に更新されます</p>';
  }else{
    // 合計時間（秒）も表示（点数降順→時間昇順で並び済み）
    let html='<table><tr><th>順位</th><th>チーム名</th><th>合計点</th><th>合計時間(秒)</th></tr>';
    list.forEach((r,i)=>{
      const rank=i+1, badge=rank===1?' 🏆':(rank===2?' 🥈':(rank===3?' 🥉':''));
      const t = (r.totalTime??0).toFixed(1);
      html+=`<tr><td>${rank}${badge}</td><td>${r.teamName}</td><td>${r.totalPoints}</td><td>${t}</td></tr>`;
    });
    html+='</table>'; interimDiv.innerHTML=html;
  }
  refreshAnswerBtn();
});

conn.on("ShowAlert", m=>alert(m));
conn.start().then(()=>conn.invoke("GetState")).catch(console.error);

/* ===== 画面描画 ===== */
function render(s){
  const q=s.question||{}; const opts=q.options||[]; const counts=s.counts||{};
  const clientVotes=s.clientVotes||{}; const isVotingOpen=s.isVotingOpen;
  const isQuestionFinalized = s.isQuestionFinalized || false;

  qTitle.textContent=q.title||''; const idx0=s.currentIndex||0; qNum.textContent=idx0+1;

  // 問1は前へ非表示
  prevBtn.style.visibility = idx0===0 ? 'hidden' : 'visible';

  // 集計ボックス
  optsDiv.innerHTML='';
  for(const o of opts){
    const label=o.label??o.Label;
    const box=document.createElement('div');
    box.className='opt';
    box.innerHTML=`<div style="font-weight:800;margin:6px 0;">${label}</div><div class="num">${counts[label]??0}</div>`;
    optsDiv.appendChild(box);
  }

  displayClientStatus(clientVotes);

  if(isVotingOpen){
    startBtn.style.display='none'; stopBtn.style.display='inline-block';
    votingStatusDiv.innerHTML='<span class="status-indicator status-open"></span><span>回答受付中</span>';
    startTimer();
  }else{
    // 終了済みの問題の場合は「回答開始」ボタンを非表示
    if(isQuestionFinalized){
      startBtn.style.display='none'; stopBtn.style.display='none';
      votingStatusDiv.innerHTML='<span class="status-indicator status-closed"></span><span>この問題は終了済み</span>';
    }else{
      startBtn.style.display='inline-block'; stopBtn.style.display='none';
      votingStatusDiv.innerHTML='<span class="status-indicator status-closed"></span><span>回答受付停止中</span>';
    }
    stopTimer();
  }

  prevBtn.disabled=!!isVotingOpen;
  nextBtn.disabled=!!isVotingOpen;

  // フラグ同期（設問が切り替わったら、その設問の確定有無で更新）
  isVotingOpenFlag = !!s.isVotingOpen;
  hasSnapshotForThisQuestion = !!questionResults[s.currentIndex||0];

  refreshAnswerBtn();
}

function displayClientStatus(clientVotes){
  const keys=Object.keys(clientVotes||{});
  if(keys.length===0){ clientStatusDiv.innerHTML='<p class="muted">まだ回答がありません</p>'; return; }
  let html='<table><tr><th>チーム名</th><th>選択</th><th>倍率</th><th>回答時間(秒)</th><th>操作</th></tr>';
  for(const k of keys){
    const d=clientVotes[k]||{};
    const team=(d.teamName||d.TeamName||'').trim()||k;
    const mul=d.multiplier||d.Multiplier||1;
    const opt=d.selectedOption||d.SelectedOption||'-';
    const tm = (d.responseTime||d.ResponseTime||0).toFixed(1);
    html+=`<tr>
      <td>${team}</td><td>${opt}</td>
      <td><span class="multiplier-badge multiplier-${mul}">×${mul}</span></td>
      <td>${tm}</td>
      <td><button class="delete-btn" onclick="deleteVoteByTeam('${team.replace(/'/g,"\\'")}')">削除</button></td>
    </tr>`;
  }
  html+='</table>'; clientStatusDiv.innerHTML=html;
}

function displayParticipants(list){
  if(!list || list.length===0){ participantsDiv.innerHTML='<p class="muted">まだ参加者がいません</p>'; return; }
  let html='<table><tr><th>チーム名</th><th>状態</th><th>選択</th><th>倍率</th><th>回答時間(秒)</th></tr>';
  list.forEach(p=>{
    const team=(p.teamName||p.TeamName||'').trim(); if(!team) return;
    const ok=p.hasAnswered||p.HasAnswered;
    const sel=p.selectedOption||p.SelectedOption||'-';
    const mul=p.multiplier||p.Multiplier||0;
    const tm=(p.responseTime||p.ResponseTime||0).toFixed(1);
    html+=`<tr><td>${team}</td><td>${ok?'回答済':'未回答'}</td><td>${ok?sel:'-'}</td><td>${ok?`×${mul}`:'-'}</td><td>${ok?tm:'-'}</td></tr>`;
  });
  html+='</table>'; participantsDiv.innerHTML=html;
}

function displayQuestionResults(index, results){
  if(!results || results.length===0){ questionResultsDiv.innerHTML='<p class="muted">結果なし</p>'; return; }
  let html=`<h3>問題${index+1}の結果</h3><table><tr><th>チーム名</th><th>選択</th><th>倍率</th><th>獲得点数</th><th>回答時間(秒)</th></tr>`;
  for(const r of results){
    const team=(r.teamName||r.TeamName||'').trim(); if(!team) continue;
    const t=(r.responseTime||r.ResponseTime||0).toFixed(1);
    html+=`<tr>
      <td>${team}</td>
      <td>${r.selectedOption||r.SelectedOption}</td>
      <td><span class="multiplier-badge multiplier-${r.multiplier||r.Multiplier}">×${r.multiplier||r.Multiplier}</span></td>
      <td>${r.points||r.Points||0}点</td>
      <td>${t}</td>
    </tr>`;
  }
  html+='</table>'; questionResultsDiv.innerHTML=html;
}

function displayFinalResults(results){
  if(!results || results.length===0) return;
  let html='<table><tr><th>順位</th><th>チーム名</th><th>合計点数</th><th>合計時間(秒)</th></tr>';
  results.forEach((r,i)=>{
    const rank=i+1, badge=rank===1?' 🏆':(rank===2?' 🥈':(rank===3?' 🥉':''));
    const team=(r.teamName||r.TeamName||'').trim(); if(!team) return;
    const t=(r.totalTime||r.TotalTime||0).toFixed(1);
    html+=`<tr><td>${rank}${badge}</td><td>${team}</td><td>${r.totalPoints||r.TotalPoints||0}点</td><td>${t}</td></tr>`;
  });
  html+='</table>';
  document.getElementById('final-results-content').innerHTML=html;
  document.getElementById('final-results-modal').style.display='block';
}

/* ===== Buttons ===== */
document.getElementById('start-voting').onclick=()=>{
    const btn = document.getElementById('start-voting');
    btn.disabled = true;
    conn.invoke("StartVoting").finally(()=> btn.disabled = false);
};
document.getElementById('stop-voting').onclick =()=>{
    const btn = document.getElementById('stop-voting');
    btn.disabled = true;
    conn.invoke("StopVoting").finally(()=> btn.disabled = false);
};
document.getElementById('prev').onclick       =()=>{
    const btn = document.getElementById('prev');
    btn.disabled = true;
    conn.invoke("PrevQuestion").finally(()=> btn.disabled = false);
};
document.getElementById('next').onclick       =()=>{
    const btn = document.getElementById('next');
    btn.disabled = true;
    conn.invoke("NextQuestion").finally(()=> btn.disabled = false);
};
document.getElementById('reset').onclick      =()=>{
  if(confirm('すべてのデータをリセットしますか？')){
    conn.invoke("ResetCounts");
    currentState=null; questionResults={};
    hasSnapshotForThisQuestion=false; isVotingOpenFlag=false;
    questionResultsDiv.innerHTML='<p class="muted">回答終了後に表示されます</p>';
    stopTimer();
    if(answerBtn){ answerBtn.style.display='none'; answerBtn.disabled=true; }
    localStorage.removeItem(STORAGE_KEY);  // localStorageもクリア
  }
};
document.getElementById('close-answer-list').onclick=()=>{ document.getElementById('answer-list-modal').style.display='none'; };

// 削除
function deleteVoteByTeam(teamName){
  if(!teamName) return;
  if(confirm(`「${teamName}」の回答を削除しますか？`)){ conn.invoke("DeleteTeamVote", teamName); }
}

// グローバル関数として公開
window.deleteVoteByTeam = deleteVoteByTeam;

// ===== localStorage バックアップ機能 =====
const STORAGE_KEY = 'gec_host_backup';

// 現在の状態をlocalStorageに保存
function saveStateToLocalStorage() {
  if (!currentState) return;

  try {
    const backup = {
      currentState: currentState,
      questionResults: questionResults,
      timestamp: Date.now(),
      isVotingOpen: isVotingOpenFlag,
      hasSnapshot: hasSnapshotForThisQuestion
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(backup));
  } catch (e) {
    console.error('Failed to save state to localStorage:', e);
  }
}

// localStorageから状態を復元
function loadStateFromLocalStorage() {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return false;

    const backup = JSON.parse(data);

    // 1時間以上前のデータは無視
    if (Date.now() - backup.timestamp > 3600000) {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }

    // 復元
    if (backup.currentState) {
      currentState = backup.currentState;
      questionResults = backup.questionResults || {};
      isVotingOpenFlag = backup.isVotingOpen || false;
      hasSnapshotForThisQuestion = backup.hasSnapshot || false;

      // UIを更新
      if (currentState) {
        render(currentState);
        refreshAnswerBtn();
      }

      console.log('State restored from localStorage');
      return true;
    }
  } catch (e) {
    console.error('Failed to load state from localStorage:', e);
  }
  return false;
}

// 定期的に自動保存（5秒ごと）
setInterval(() => {
  if (currentState) {
    saveStateToLocalStorage();
  }
}, 5000);

// ページ読み込み時に復元を試みる
window.addEventListener('load', () => {
  loadStateFromLocalStorage();
});

// ページを離れる前に保存
window.addEventListener('beforeunload', () => {
  saveStateToLocalStorage();
});