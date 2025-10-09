// =======================
// SignalR 接続の初期化
// =======================
function getStableUid() {
    let uid = localStorage.getItem('gec_uid');
    if (!uid) {
        uid = (crypto?.randomUUID?.() || ('uid-' + Math.random().toString(36).slice(2) + Date.now().toString(36)));
        localStorage.setItem('gec_uid', uid);
    }
    return uid;
}
const HOST_UID = getStableUid();

// const conn=new signalR.HubConnectionBuilder().withUrl("/hub/vote",{transport:signalR.HttpTransportType.LongPolling}).withAutomaticReconnect().build();
const conn = new signalR.HubConnectionBuilder()
    .withUrl(`/hub/vote?uid=${encodeURIComponent(HOST_UID)}`,
        { transport: signalR.HttpTransportType.WebSockets })
    .withAutomaticReconnect()
    .build();

// =======================
// DOM要素参照
// =======================
const qTitle = document.getElementById('q-title');
const qNum = document.getElementById('q-num');
const optsDiv = document.getElementById('opts');
const clientStatusDiv = document.getElementById('client-status');
const participantsDiv = document.getElementById('participants');
const questionResultsDiv = document.getElementById('question-results');
const votingStatusDiv = document.getElementById('voting-status');
const timerDiv = document.getElementById('timer');
const answerBtn = document.getElementById('show-result');
const startBtn = document.getElementById('start-voting');
const stopBtn = document.getElementById('stop-voting');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const interimDiv = document.getElementById('interim-totals');

// =======================
// URLの一元管理（Index.cshtml から受け取り）
// =======================
let baseUrl = (window.baseUrlFromServer || '').trim();
if (!baseUrl) {
    // 念のためのフォールバック（サーバが埋め込めなかった場合）
    baseUrl = window.location.origin;
}
let joinUrl = (window.joinUrlFromServer || '').trim();
if (!joinUrl) {
    joinUrl = `${baseUrl}/vote`;
}

// =======================
// 受付/確定フラグ・状態
// =======================
let currentState = null;
let questionResults = {};
let qr = null;
let participantsLatest = [];

// 受付/確定フラグ（表示制御の一元管理）
let isVotingOpenFlag = false;
let hasSnapshotForThisQuestion = false;
let isQuestionStartedFlag = false;

// =======================
// タイマー（表示用）
// =======================
let timerInterval = null, timerStartMs = 0;
function startTimer() {
    if (timerInterval) return;
    timerStartMs = Date.now();
    if (timerDiv) {
        timerDiv.style.display = 'block';
        timerDiv.textContent = '0秒';
    }
    timerInterval = setInterval(() => {
        const sec = Math.floor((Date.now() - timerStartMs) / 1000);
        if (timerDiv) timerDiv.textContent = `${sec}秒`;
    }, 200);
}
function stopTimer() {
    if (!timerInterval) return;
    clearInterval(timerInterval);
    timerInterval = null;
    if (timerDiv) {
        timerDiv.style.display = 'none';
        timerDiv.textContent = '0秒';
    }
}

// =======================
// QR／参加URL 表示
// =======================
const joinLink = document.getElementById('join-link');
const qrModal = document.getElementById('qr-modal');
const showQrModalBtn = document.getElementById('show-qr-modal');

if (joinLink) {
    joinLink.textContent = joinUrl;
    joinLink.href = joinUrl;
}

if (showQrModalBtn && qrModal) {
    showQrModalBtn.onclick = () => {
        if (!qr) {
            qr = new QRious({
                element: document.getElementById('qr'),
                value: joinUrl,
                size: 250
            });
        } else {
            qr.set({ value: joinUrl });
        }
        qrModal.style.display = 'block';
    };
    qrModal.onclick = e => {
        if (e.target === qrModal) qrModal.style.display = 'none';
    };
}

const editUrlBtn = document.getElementById('edit-url');
if (editUrlBtn) {
    editUrlBtn.onclick = () => {
        const v = prompt("参加URLを入力", joinUrl) || joinUrl;
        joinUrl = v.trim() || joinUrl;
        if (qr) qr.set({ value: joinUrl });
        if (joinLink) {
            joinLink.textContent = joinUrl;
            joinLink.href = joinUrl;
        }
    };
}

// =======================
// 「回答一覧/最終結果」ボタン表示制御
// =======================
function refreshAnswerBtn() {
    if (!answerBtn || !currentState) return;
    const idx = currentState.currentIndex || 0;
    const total = currentState.totalQuestions || 1;
    const isLast = idx === total - 1;

    // 表示条件：受付停止中 かつ スナップショット有り
    const shouldShow = (!isVotingOpenFlag && hasSnapshotForThisQuestion);
    answerBtn.style.display = shouldShow ? 'inline-block' : 'none';
    answerBtn.disabled = false;

    if (isLast) {
        answerBtn.textContent = '最終結果';
        answerBtn.title = shouldShow ? '' : '最後の問題を「回答終了」してから表示できます';
        answerBtn.onclick = () => conn.invoke('GetGameResults');
    } else {
        answerBtn.textContent = '回答一覧';
        answerBtn.title = shouldShow ? '' : 'この問題を「回答終了」してから表示できます';
        answerBtn.onclick = () => conn.invoke('ShowQuestionResults');
    }
}

// =======================
// Hub受信
// =======================
conn.on("StateUpdated", s => {
    currentState = s;

    // フラグ更新（設問ごと）
    isVotingOpenFlag = !!s.isVotingOpen;
    hasSnapshotForThisQuestion = !!(s.isQuestionFinalized || questionResults[s.currentIndex || 0]);
    isQuestionStartedFlag = !!s.isQuestionStarted;

    try {
        const rmap = s?.resultsByIndex || {};
        const key = String(s?.currentIndex ?? 0);
        const my = rmap[key];
        const newIndex = Number(state?.currentIndex || 0);

        if (newIndex !== currentQuestionIndex && !hasVotedThisRound) {
            currentQuestionIndex = newIndex;
            hasVotedThisRound = false;
            currentSelectedOption = null;
            selectedMultiplier = 0;
            document.querySelectorAll('.choice').forEach(b => b.classList.remove('selected-answer'));
            multipliersEl?.querySelectorAll('.multiplier-btn').forEach(b => b.classList.remove('selected'));
        }

        if (my && typeof my === 'object') {
            renderResultForCurrentQuestion({
                counts: my.counts || { A: 0, B: 0 },
                winner: my.winner || null,
                voters: my.voters || 0,
                finalizedAtUtc: my.finalizedAtUtc || null
            });
        } else {
            // 未確定なら、途中結果を描画する／空表示にする等、既存ロジックへ
            renderIntermediateCounts(s?.counts || { A: 0, B: 0 });
        }
    } catch (e) {
    console.warn('result render error', e);
    }

    // 画面更新
    render(s);

    // ボタン表示制御
    refreshAnswerBtn();
});

conn.on("GameReset", () => {
    try {
        stopTimer && stopTimer();

        // 画面側のキャッシュ類を完全初期化
        questionResults = {};          // 問題別結果のキャッシュ
        hasSnapshotForThisQuestion = false;
        isQuestionStartedFlag = false;

        // モーダル等を閉じる
        const modal = document.getElementById('answer-list-modal');
        if (modal) modal.style.display = 'none';

        // UI を初期化（空で描画してから、直後に来る StateUpdated/ParticipantsUpdated を受けて再描画）
        displayParticipants([]);
        render({
            currentIndex: 0,
            totalQuestions: (currentState?.totalQuestions) || 1,
            question: null,
            counts: { A: 0, B: 0 },
            isVotingOpen: false,
            isQuestionStarted: false,
            isQuestionFinalized: false,
            usedMultipliersByTeam: {},
            resultsByIndex: {}
        });
        refreshAnswerBtn();
    } catch (e) {
        console.warn('GameReset handler error', e);
    }
});

conn.on("ParticipantsUpdated", list => {
    //participantsLatest = list || [];
    //displayParticipants(participantsLatest);

    if (Array.isArray(list) && list.length > 0) {
        participantsLatest = list;
        displayParticipants(participantsLatest);
    } else if (Array.isArray(list) && list.length === 0) {
        // クリアしたい意図の明確な空ブロードキャスト以外は、無視する運用にするなら↓コメントアウト
        // participantsLatest = [];
        // displayParticipants(participantsLatest);
        // ここでは何もしない（前回表示をキープ）
    }
});

conn.on("VotingStatusChanged", isOpen => {
    isVotingOpenFlag = !!isOpen;
    if (isOpen) {
        if (startBtn) { startBtn.style.display = 'none'; startBtn.disabled = false; }
        if (stopBtn) { stopBtn.style.display = 'inline-block'; stopBtn.disabled = false; }
        if (votingStatusDiv) votingStatusDiv.innerHTML = '<span class="status-indicator status-open"></span><span>回答受付中</span>';
        startTimer();
    } else {
        if (startBtn) { startBtn.style.display = 'inline-block'; startBtn.disabled = false; }
        if (stopBtn) { stopBtn.style.display = 'none'; stopBtn.disabled = false; }
        if (votingStatusDiv) votingStatusDiv.innerHTML = '<span class="status-indicator status-closed"></span><span>回答受付停止中</span>';
        stopTimer();
    }
    if (nextBtn) nextBtn.disabled = !!isOpen;
    if (prevBtn) prevBtn.disabled = !!isOpen;
    if (startBtn) {
        const canStart = (!isOpen) && (!isQuestionStartedFlag);
        startBtn.disabled = !canStart;
        startBtn.title = canStart ? '' : 'この問題は一度開始されているため再度開始できません（リセットで解除）';
    }
    refreshAnswerBtn();
});

conn.on("QuestionResults", (index, results) => {
    questionResults[index] = results;
    if (currentState && index === (currentState.currentIndex || 0)) hasSnapshotForThisQuestion = true;
    displayQuestionResults(index, results);
    refreshAnswerBtn();
});

conn.on("GameResults", results => displayFinalResults(results));

conn.on("ShowPerQuestionResults", (index, rows) => {
    if (currentState && index === (currentState.currentIndex || 0)) hasSnapshotForThisQuestion = true;

    const modal = document.getElementById('answer-list-modal');
    const qDiv = document.getElementById('answer-list-question');
    const cDiv = document.getElementById('answer-list-content');
    const title = (currentState?.question?.title) || `問題${index + 1}`;

    const groups = { A: [], B: [] };
    (rows || []).forEach(r => {
        const opt = (r.selectedOption || r.SelectedOption || '-').toUpperCase();
        const team = (r.teamName || r.TeamName || '').trim();
        const mul = r.multiplier || r.Multiplier || 1;
        if (!team) return;
        if (opt === 'A' || opt === 'B') groups[opt].push({ team, mul });
    });
    const countA = groups.A.length, countB = groups.B.length;

    const titleEl = document.getElementById('answer-list-title');
    if (titleEl) titleEl.textContent = `回答一覧（A: ${countA}チーム / B: ${countB}チーム）`;
    if (qDiv) qDiv.textContent = title;

    let html = '';
    ['A', 'B'].forEach(opt => {
        const list = groups[opt];
        html += `
      <div style="margin-bottom:20px;padding:16px;background:#f9fafb;border-radius:8px;">
        <div style="font-size:18px;font-weight:700;color:#111;margin-bottom:12px;">
          選択肢 ${opt} <span style="font-weight:400;color:#666;">(${list.length}件)</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${list.map(x => `
            <div style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;">
              <span style="font-weight:600;">${x.team}</span>
              <span style="color:#666;margin-left:8px;">×${x.mul}</span>
            </div>`).join('') || `<div class="no-vote">回答なし</div>`}
        </div>
      </div>`;
    });
    if (cDiv) cDiv.innerHTML = html;
    if (modal) modal.style.display = 'block';
    refreshAnswerBtn();
});
conn.on("ClosePerQuestionResults", () => {
    const modal = document.getElementById('answer-list-modal');
    if (modal) modal.style.display = 'none';
    refreshAnswerBtn();
});

conn.on("VoteDeleted", () => { conn.invoke("GetState"); });

conn.on("InterimTotalsUpdated", list => {
    if (!list || list.length === 0) {
        interimDiv.innerHTML = '<p class="muted">回答終了後に更新されます</p>';
    } else {
        // 合計時間（秒）も表示（点数降順→時間昇順で並び済み）
        let html = '<table><tr><th>順位</th><th>チーム名</th><th>合計点</th><th>合計時間(秒)</th></tr>';
        list.forEach((r, i) => {
            const rank = i + 1, badge = rank === 1 ? ' 🏆' : (rank === 2 ? ' 🥈' : (rank === 3 ? ' 🥉' : ''));
            const t = (r.totalTime ?? 0).toFixed(1);
            html += `<tr><td>${rank}${badge}</td><td>${r.teamName}</td><td>${r.totalPoints}</td><td>${t}</td></tr>`;
        });
        html += '</table>';
        interimDiv.innerHTML = html;
    }
    refreshAnswerBtn();
});

conn.on("ShowAlert", m => alert(m));

// 接続開始
conn.start()
    .then(() => conn.invoke("GetState"))
    .catch(console.error);

// =======================
// 画面描画
// =======================
function render(s) {
    const q = s.question || {};
    const opts = q.options || [];
    const counts = s.counts || {};
    const clientVotes = s.clientVotes || {};
    const isVotingOpen = s.isVotingOpen;

    if (qTitle) qTitle.textContent = q.title || '';
    const idx0 = s.currentIndex || 0;
    if (qNum) qNum.textContent = idx0 + 1;

    // 問1は前へ非表示
    if (prevBtn) prevBtn.style.visibility = idx0 === 0 ? 'hidden' : 'visible';

    // 最終問題は次へ非表示
    const totalQuestions = s.totalQuestions || 3;
    if (nextBtn) nextBtn.style.visibility = idx0 === totalQuestions - 1 ? 'hidden' : 'visible';

    // 集計ボックス（★修正: endChild -> appendChild）
    if (optsDiv) {
        optsDiv.innerHTML = '';
        for (const o of opts) {
            const label = o.label ?? o.Label;
            const box = document.createElement('div');
            box.className = 'opt';
            box.innerHTML = `<div style="font-weight:800;margin:6px 0;">${label}</div><div class="num">${counts[label] ?? 0}</div>`;
            optsDiv.appendChild(box); // ← ここを appendChild に修正
        }
    }

    // クライアント回答一覧
    displayClientStatus(clientVotes);

    // 受付状態のUI
    if (isVotingOpen) {
        if (startBtn) startBtn.style.display = 'none';
        if (stopBtn) stopBtn.style.display = 'inline-block';
        if (votingStatusDiv) votingStatusDiv.innerHTML = '<span class="status-indicator status-open"></span><span>回答受付中</span>';
        startTimer();
    } else {
        if (startBtn) startBtn.style.display = 'inline-block';
        if (stopBtn) stopBtn.style.display = 'none';
        if (votingStatusDiv) votingStatusDiv.innerHTML = '<span class="status-indicator status-closed"></span><span>回答受付停止中</span>';
        stopTimer();
    }

    if (prevBtn) prevBtn.disabled = !!isVotingOpen;
    if (nextBtn) nextBtn.disabled = !!isVotingOpen;

    // フラグ同期（設問が切り替わったら、その設問の確定/開始状態で更新）
    isVotingOpenFlag = !!s.isVotingOpen;
    hasSnapshotForThisQuestion = !!(s.isQuestionFinalized || questionResults[s.currentIndex || 0]);
    isQuestionStartedFlag = !!s.isQuestionStarted;

    // 「回答開始」ボタンの活性条件:
    // ・受付中ではない
    // ・この設問が未開始（開始済みはリセットでのみ解除）
    if (startBtn) {
        const canStart = (!isVotingOpenFlag) && (!isQuestionStartedFlag);
        startBtn.disabled = !canStart;
        startBtn.title = canStart ? '' : 'この問題は一度開始されているため再度開始できません（リセットで解除）';
    }

    refreshAnswerBtn();
}

function displayClientStatus(clientVotes) {
    const keys = Object.keys(clientVotes || {});
    if (keys.length === 0) {
        clientStatusDiv.innerHTML = '<p class="muted">まだ回答がありません</p>';
        return;
    }

    // テーブルを動的に作成
    const table = document.createElement('table');
    const headerRow = document.createElement('tr');
    headerRow.innerHTML = '<th>チーム名</th><th>選択</th><th>倍率</th><th>回答時間(秒)</th><th>操作</th>';
    table.appendChild(headerRow);

    for (const k of keys) {
        const d = clientVotes[k] || {};
        const team = (d.teamName || d.TeamName || '').trim() || k;
        const mul = d.multiplier || d.Multiplier || 1;
        const opt = d.selectedOption || d.SelectedOption || '-';
        const tm = (d.responseTime || d.ResponseTime || 0).toFixed(1);

        const tr = document.createElement('tr');

        // チーム名
        const tdTeam = document.createElement('td');
        tdTeam.textContent = team;
        tr.appendChild(tdTeam);

        // 選択
        const tdOpt = document.createElement('td');
        tdOpt.textContent = opt;
        tr.appendChild(tdOpt);

        // 倍率
        const tdMul = document.createElement('td');
        const span = document.createElement('span');
        span.className = `multiplier-badge multiplier-${mul}`;
        span.textContent = `×${mul}`;
        tdMul.appendChild(span);
        tr.appendChild(tdMul);

        // 回答時間
        const tdTime = document.createElement('td');
        tdTime.textContent = tm;
        tr.appendChild(tdTime);

        // 削除ボタン
        const tdBtn = document.createElement('td');
        const btn = document.createElement('button');
        btn.className = 'delete-btn';
        btn.textContent = '削除';
        btn.addEventListener('click', () => {
            console.log('[CLIENT DELETE] Button clicked for team:', team);
            deleteVoteByTeam(team);
        });
        tdBtn.appendChild(btn);
        tr.appendChild(tdBtn);

        table.appendChild(tr);
    }

    clientStatusDiv.innerHTML = '';
    clientStatusDiv.appendChild(table);
}



function displayParticipants(list) {
    if (!list || list.length === 0) {
        participantsDiv.innerHTML = '<p class="muted">まだ参加者がいません</p>';
        return;
    }
    let html = '<table><tr><th>チーム名</th><th>状態</th><th>選択</th><th>倍率</th><th>回答時間(秒)</th></tr>';
    list.forEach(p => {
        const team = (p.teamName || p.TeamName || '').trim();
        if (!team) return;
        const ok = p.hasAnswered || p.HasAnswered;
        const sel = p.selectedOption || p.SelectedOption || '-';
        const mul = p.multiplier || p.Multiplier || 0;
        const tm = (p.responseTime || p.ResponseTime || 0).toFixed(1);
        html += `<tr><td>${team}</td><td>${ok ? '回答済' : '未回答'}</td><td>${ok ? sel : '-'}</td><td>${ok ? `×${mul}` : '-'}</td><td>${ok ? tm : '-'}</td></tr>`;
    });
    html += '</table>';
    participantsDiv.innerHTML = html;
}

function displayQuestionResults(index, results) {
    if (!results || results.length === 0) {
        questionResultsDiv.innerHTML = '<p class="muted">結果なし</p>';
        return;
    }
    let html = `<h3>問題${index + 1}の結果</h3><table><tr><th>チーム名</th><th>選択</th><th>倍率</th><th>獲得点数</th><th>回答時間(秒)</th></tr>`;
    for (const r of results) {
        const team = (r.teamName || r.TeamName || '').trim();
        if (!team) continue;
        const t = (r.responseTime || r.ResponseTime || 0).toFixed(1);
        html += `<tr>
      <td>${team}</td>
      <td>${r.selectedOption || r.SelectedOption}</td>
      <td><span class="multiplier-badge multiplier-${r.multiplier || r.Multiplier}">×${r.multiplier || r.Multiplier}</span></td>
      <td>${r.points || r.Points || 0}点</td>
      <td>${t}</td>
    </tr>`;
    }
    html += '</table>';
    questionResultsDiv.innerHTML = html;
}

function displayFinalResults(results) {
    if (!results || results.length === 0) return;
    let html = '<table><tr><th>順位</th><th>チーム名</th><th>合計点数</th><th>合計時間(秒)</th></tr>';
    results.forEach((r, i) => {
        const rank = i + 1, badge = rank === 1 ? ' 🏆' : (rank === 2 ? ' 🥈' : (rank === 3 ? ' 🥉' : ''));
        const team = (r.teamName || r.TeamName || '').trim();
        if (!team) return;
        const t = (r.totalTime || r.TotalTime || 0).toFixed(1);
        html += `<tr><td>${rank}${badge}</td><td>${team}</td><td>${r.totalPoints || r.TotalPoints || 0}点</td><td>${t}</td></tr>`;
    });
    html += '</table>';
    const modal = document.getElementById('final-results-modal');
    const content = document.getElementById('final-results-content');
    if (content) content.innerHTML = html;
    if (modal) modal.style.display = 'block';
}

// =======================
// 未回答取得
// =======================
function getUnansweredTeams() {
    return (participantsLatest || [])
        .filter(p => !(p.hasAnswered || p.HasAnswered))
        .map(p => (p.teamName || p.TeamName || '').trim())
        .filter(Boolean);
}

// =======================
// ボタンのイベント
// =======================
const startVotingBtn = document.getElementById('start-voting');
if (startVotingBtn) {
    startVotingBtn.onclick = () => {
        const btn = startVotingBtn;
        btn.disabled = true;
        conn.invoke("StartVoting").finally(() => btn.disabled = false);
    };
}
const stopVotingBtn = document.getElementById('stop-voting');
if (stopVotingBtn) {
    stopVotingBtn.onclick = () => {
        const btn = stopVotingBtn;
        const missing = getUnansweredTeams();

        // 未回答がいる場合は確認モーダル
        if (missing.length > 0) {
            const modal = document.getElementById('confirm-stop-modal');
            const listDiv = document.getElementById('confirm-stop-list');
            if (listDiv) {
                listDiv.innerHTML = missing.map(name => `
          <div style="padding:6px 10px; background:#fff; border:1px solid #e5e7eb; border-radius:6px; margin:4px 0;">
            ${name}
          </div>
        `).join('') || '<div>（該当なし）</div>';
            }

            if (modal) {
                modal.style.display = 'block';

                // 閉じる系
                const cancelBtn = document.getElementById('confirm-stop-cancel');
                const okBtn = document.getElementById('confirm-stop-ok');

                const close = () => { modal.style.display = 'none'; };
                if (cancelBtn) cancelBtn.onclick = close;
                modal.onclick = (e) => { if (e.target === modal) close(); };

                if (okBtn) {
                    okBtn.onclick = () => {
                        close();
                        btn.disabled = true;
                        conn.invoke("StopVoting").finally(() => btn.disabled = false);
                    };
                }
            }
        } else {
            // 未回答なし → そのまま終了
            btn.disabled = true;
            conn.invoke("StopVoting").finally(() => btn.disabled = false);
        }
    };
}

const prevQuestionBtn = document.getElementById('prev');
if (prevQuestionBtn) {
    prevQuestionBtn.onclick = () => {
        const btn = prevQuestionBtn;
        btn.disabled = true;
        conn.invoke("PrevQuestion").finally(() => btn.disabled = false);
    };
}
const nextQuestionBtn = document.getElementById('next');
if (nextQuestionBtn) {
    nextQuestionBtn.onclick = () => {
        const btn = nextQuestionBtn;
        btn.disabled = true;
        conn.invoke("NextQuestion").finally(() => btn.disabled = false);
    };
}
const resetBtn = document.getElementById('reset');
if (resetBtn) {
    resetBtn.onclick = () => {
        if (confirm('すべてのデータをリセットしますか？')) {
            conn.invoke("ResetCounts");
            currentState = null; questionResults = {};
            hasSnapshotForThisQuestion = false;
            isVotingOpenFlag = false;
            isQuestionStartedFlag = false;
            if (questionResultsDiv) questionResultsDiv.innerHTML = '<p class="muted">回答終了後に表示されます</p>';
            stopTimer();
            if (answerBtn) { answerBtn.style.display = 'none'; answerBtn.disabled = true; }
              if (startBtn) { startBtn.disabled = false; startBtn.title = ''; }
              // localStorageもクリア
            localStorage.removeItem('gec_host_backup');
            localStorage.clear();
        }
    };
}

const closeAnswerListBtn = document.getElementById('close-answer-list');
if (closeAnswerListBtn) {
    closeAnswerListBtn.onclick = () => {
        const modal = document.getElementById('answer-list-modal');
        if (modal) modal.style.display = 'none';
    };
}

// =======================
// 回答削除（グローバル公開）
// =======================
function deleteVoteByTeam(teamName) {
    console.log('[CLIENT DELETE] Called with teamName:', teamName);
    if (!teamName) {
        console.log('[CLIENT DELETE] teamName is empty, returning');
        return;
    }
    if (confirm(`「${teamName}」の回答を削除しますか？`)) {
        console.log('[CLIENT DELETE] Invoking DeleteTeamVote on server');
        conn.invoke("DeleteTeamVote", teamName)
            .then(() => console.log('[CLIENT DELETE] Success'))
            .catch(err => console.error('[CLIENT DELETE] Error:', err));
    } else {
        console.log('[CLIENT DELETE] User cancelled');
    }
}
window.deleteVoteByTeam = deleteVoteByTeam;
