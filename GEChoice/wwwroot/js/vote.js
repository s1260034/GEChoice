/* ===== DOM helpers ===== */
const $ = (id) => document.getElementById(id);
const text = (el, s) => { if (el) el.textContent = s; };
const show = (el) => { if (el) el.classList.remove('hide'); };
const hide = (el) => { if (el) el.classList.add('hide'); };
const toggle = (el, v) => v ? show(el) : hide(el);

/* ===== 要素参照 ===== */
const dot = $('dot');
const stxt = $('stxt');
const qTitle = $('q-title');
const countdownEl = $('countdown');
const lateWarnEl = $('late-warning');
const votingArea = $('voting-area');
const votingClosed = $('voting-closed');
const choicesEl = $('choices');
const msgEl = $('msg');
const teamTag = $('teamTag');
const editTeamBtn = $('editTeam');
const multipliersEl = $('multipliers');
const backdrop = $('backdrop');
const teamInput = $('teamInput');
const btnCancel = $('cancelTeam');
const btnSave = $('saveTeam');

const setConn = (ok, msg) => {
    if (dot) dot.className = 'dot ' + (ok ? 'ok' : 'ng');
    text(stxt, msg || (ok ? 'オンライン' : 'オフライン'));
};

/* ===== クライアント状態 ===== */
let isVotingOpen = false;
let currentQuestionIndex = 0;
let hasVotedThisRound = false;
let currentSelectedOption = null;
let selectedMultiplier = 0; // 現在選択中の倍率（未選択=0）

/* ===== チーム名 ===== */
const TEAM_KEY = 'gec_team_name';
const getTeam = () => (localStorage.getItem(TEAM_KEY) || '').trim();
const setTeam = (name) => {
    localStorage.setItem(TEAM_KEY, name || '');
    if (teamTag) {
        if (name) { teamTag.textContent = name; teamTag.classList.remove('hide'); }
        else { teamTag.textContent = ''; teamTag.classList.add('hide'); }
    }
};
setTeam(getTeam());

function openTeamModal(initial = '') {
    if (!backdrop || !teamInput) return false;
    teamInput.value = initial || '';
    show(backdrop);
    setTimeout(() => teamInput.focus(), 0);
    return true;
}
function closeTeamModal() { hide(backdrop); }
if (btnCancel) btnCancel.onclick = closeTeamModal;
if (btnSave) btnSave.onclick = () => {
    const v = (teamInput.value || '').trim();
    if (!v) { teamInput.focus(); return; }
    setTeam(v); closeTeamModal(); text(msgEl, 'チーム名を設定しました');
    invoke('UpdateTeamName', v);            // ★これを追加
};

// モーダル未使用の prompt 経路
if (editTeamBtn) editTeamBtn.onclick = () => {
    const cur = getTeam();
    if (!openTeamModal(cur)) {
        const name = window.prompt('チーム名を入力してください', cur || '');
        if (name != null) {
            const v = (name || '').trim();
            setTeam(v);
            invoke('UpdateTeamName', v);        // ★これを追加
        }
    }
};
if (!getTeam()) openTeamModal('');

/* ===== SignalR ===== */
const connection = new signalR.HubConnectionBuilder()
    .withUrl('/hub/vote')
    .withAutomaticReconnect()
    .build();
const invoke = async (m, ...args) => { try { await connection.invoke(m, ...args); } catch (e) { console.error(m, e); } };

/* ===== タイマー（2:00 & 残り30秒で警告） ===== */
const DURATION_MS = 2 * 60 * 1000;
let timerId = null;
const fmt = (ms) => {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
};
function clearCountdown() {
    if (timerId) { clearInterval(timerId); timerId = null; }
    hide(countdownEl); hide(lateWarnEl);
}
function startCountdownFromUtc(utcIso) {
    clearCountdown();
    const startMs = Date.parse(utcIso || new Date().toISOString());
    const endMs = startMs + DURATION_MS;
    show(countdownEl);
    let warned = false;
    const tick = () => {
        const remain = endMs - Date.now();
        text(countdownEl, fmt(remain));
        const warn = remain <= 30000 && remain > 0;
        if (warn !== warned) { toggle(lateWarnEl, warn); warned = warn; }
        if (remain <= 0) {
            text(countdownEl, '00:00'); hide(lateWarnEl); clearCountdown();
            // 受付終了の瞬間はローカルでも押せないように
            document.querySelectorAll('.choice').forEach(b => b.disabled = true);
            document.querySelectorAll('.multiplier-btn').forEach(b => b.disabled = true);
        }
    };
    tick(); timerId = setInterval(tick, 200);
}

/* ===== UI制御 ===== */
function updateVoteButtons() {
    const team = getTeam();
    const canVote = !!team && isVotingOpen && selectedMultiplier > 0 && !hasVotedThisRound;
    document.querySelectorAll('.choice').forEach(b => b.disabled = !canVote);
}

/* ===== 使用済み倍率の反映（ゲーム全体で使えない点を無効化） ===== */
function applyUsedMultipliers(usedSet) {
    if (!multipliersEl) return;
    multipliersEl.querySelectorAll('.multiplier-btn').forEach(btn => {
        const v = Number(btn.getAttribute('data-value') || '0');
        // まず lockAfterVote で残った状態を全解除
        btn.disabled = false;
        btn.style.pointerEvents = '';
        btn.style.opacity = '';
        btn.classList.remove('used', 'selected');
        // その上で「ゲーム全体で使用済み」のみ再度 disable
        if (usedSet.has(v)) {
            btn.disabled = true;
            btn.classList.add('used');
        }
    });
    // ラウンド開始時は未選択状態に戻す
    selectedMultiplier = 0;
}

/* 回答確定後に“そのラウンドだけ”完全ロック */
function lockAfterVote(multiplier, selectedLabel) {
    hasVotedThisRound = true;
    currentSelectedOption = selectedLabel || currentSelectedOption;

    // 選択肢：全て押下不可＆選択済みをハイライト
    document.querySelectorAll('.choice').forEach(b => {
        b.disabled = true;
        if (currentSelectedOption && (b.textContent || '').startsWith(currentSelectedOption)) {
            b.classList.add('selected-answer');
        }
    });

    // 倍率：選んだものは used + selected、他は触れない
    multipliersEl?.querySelectorAll('.multiplier-btn').forEach(btn => {
        const v = Number(btn.getAttribute('data-value') || '0');
        if (v === multiplier) {
            btn.disabled = true;
            btn.classList.add('used', 'selected');
        } else {
            btn.disabled = true;           // このラウンドは触れない
            btn.style.pointerEvents = 'none';
            btn.style.opacity = '0.7';
        }
    });

    updateVoteButtons();
}

/* ===== 選択肢の描画（クリックで確認モーダル） ===== */
function renderChoices(options = []) {
    if (!choicesEl) return;
    choicesEl.innerHTML = '';
    options.forEach(label => {
        const btn = document.createElement('button');
        btn.className = 'choice';
        btn.type = 'button';
        btn.textContent = `${label} を選ぶ`;
        btn.onclick = () => {
            const team = getTeam();
            if (!team) { text(msgEl, 'チーム名を設定してください。'); return; }
            if (selectedMultiplier <= 0) { text(msgEl, '点数（倍率）を選択してください。'); return; }
            showConfirmModal(label, team, selectedMultiplier);
        };
        choicesEl.appendChild(btn);
    });
    updateVoteButtons();
}

/* ===== 確認モーダル ===== */
function showConfirmModal(label, teamName, multiplier) {
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
    <div class="confirm-box">
      <div class="confirm-title">📝 回答確認</div>
      <div class="confirm-message">この選択で回答します。<br>一度回答すると変更できません。</div>
      <div class="confirm-choice">${label}</div>
      <div class="confirm-choice-detail">
        <div class="confirm-choice-item"><div class="confirm-choice-label">チーム名</div><div class="confirm-choice-value">${teamName || '未設定'}</div></div>
        <div class="confirm-choice-item"><div class="confirm-choice-label">使用ポイント</div><div class="confirm-choice-value">${multiplier}点</div></div>
      </div>
      <div class="confirm-buttons">
        <button class="confirm-btn confirm-cancel">戻る</button>
        <button class="confirm-btn confirm-ok">確定する ✓</button>
      </div>
    </div>`;
    document.body.appendChild(modal);

    modal.querySelector('.confirm-cancel').onclick = () => document.body.removeChild(modal);
    modal.querySelector('.confirm-ok').onclick = async () => {
        try {
            // 送信＆即ロック（体感をキビキビに）
            currentSelectedOption = label;
            lockAfterVote(multiplier, label);
            await invoke('SubmitWithMultiplier', label, multiplier, teamName);
            text(msgEl, `${teamName ? `[${teamName}] ` : ''}${label} を ${multiplier}点で選択しました`);
            try { navigator.vibrate && navigator.vibrate(15); } catch { /* noop */ }
        } finally {
            document.body.removeChild(modal);
        }
    };
}

/* ===== 倍率ボタン ===== */
if (multipliersEl) {
    multipliersEl.querySelectorAll('.multiplier-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.disabled || btn.classList.contains('used')) return;
            if (hasVotedThisRound) { text(msgEl, '回答後は倍率を変更できません'); return; }
            multipliersEl.querySelectorAll('.multiplier-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            selectedMultiplier = Number(btn.getAttribute('data-value') || '0');
            text(msgEl, `${selectedMultiplier}点を選択しました`);
            updateVoteButtons();
        });
    });
}

/* ===== Hubイベント ===== */
connection.onreconnecting(() => setConn(false, '再接続中…'));
connection.onreconnected(async () => {
    setConn(true, 'オンライン');
    await invoke('GetState');
    const t = getTeam();
    if (t) { invoke('UpdateTeamName', t); }
});
connection.onclose(() => setConn(false, '切断'));

/* 正史：BuildState に合わせる（question.title / options[].label or ["A","B"] / usedMultipliersByTeam / currentIndex / isVotingOpen / votingStartTime） */
connection.on('StateUpdated', async (state) => {
    try {
        setConn(true);
        isVotingOpen = !!state?.isVotingOpen;

        // タイトル
        text(qTitle, state?.question?.title || '問題');

        // 問切替検知：回答ロックの解除（次の問題へ）
        const newIndex = Number(state?.currentIndex || 0);
        if (newIndex !== currentQuestionIndex) {
            currentQuestionIndex = newIndex;
            hasVotedThisRound = false;
            currentSelectedOption = null;
            selectedMultiplier = 0;
            // ボタンの選択見た目をクリア
            document.querySelectorAll('.choice').forEach(b => b.classList.remove('selected-answer'));
            multipliersEl?.querySelectorAll('.multiplier-btn').forEach(b => b.classList.remove('selected'));
        }

        // 選択肢（"['A','B']" または "[{label:'A'},{label:'B'}]" の両対応）
        const rawOpts = Array.isArray(state?.question?.options) ? state.question.options : [];
        const opts = rawOpts.map(o => (typeof o === 'string' ? o : (o?.label ?? '')))
            .filter(s => typeof s === 'string' && s.length > 0);
        renderChoices(opts);

        // 受付表示とタイマー
        if (isVotingOpen) {
            votingArea.classList.remove('hide'); votingClosed.classList.add('hide');
            if (state?.votingStartTime) { startCountdownFromUtc(state.votingStartTime); }
            else { setTimeout(() => startCountdownFromUtc(new Date().toISOString()), 300); }
        } else {
            votingArea.classList.add('hide'); votingClosed.classList.remove('hide');
            clearCountdown();
        }

        // チームごとの使用済み倍率を反映（このゲーム全体で使えない点を無効化）
        const team = getTeam();
        const usedList = (state && state.usedMultipliersByTeam && team)
            ? (state.usedMultipliersByTeam[team] || [])
            : [];
        const used = new Set(Array.isArray(usedList) ? usedList : []);
        applyUsedMultipliers(used);

        // ラウンド中ロックの最終調整
        updateVoteButtons();
    } catch (e) {
        console.error('StateUpdated error', e);
        // 例外で描画が止まっても状態を取り直して自己復旧を試みる
        try { await invoke('GetState'); } catch { /* noop */ }
    }
});

/* 受付状態の単発更新：即時タイマーを暫定開始→GetStateで厳密同期 */
connection.on('VotingStatusChanged', (isOpen) => {
    isVotingOpen = !!isOpen;
    if (isOpen) {
        hasVotedThisRound = false;
        currentSelectedOption = null;
        selectedMultiplier = 0;
        document.querySelectorAll('.choice').forEach(b => b.classList.remove('selected-answer'));
        multipliersEl?.querySelectorAll('.multiplier-btn').forEach(b => b.classList.remove('selected'));
        votingArea.classList.remove('hide'); votingClosed.classList.add('hide');
        text(msgEl, '点数を選択してから回答してください');
        startCountdownFromUtc(new Date().toISOString());
        invoke('GetState'); // 厳密時刻・使用済み倍率などを上書き
    } else {
        votingArea.classList.add('hide'); votingClosed.classList.remove('hide');
        clearCountdown();
    }
    updateVoteButtons();
});

/* サーバ確定（安全側）：選んだ倍率は「使用済み」に */
connection.on('MultiplierUsed', (multiplier) => {
    lockAfterVote(Number(multiplier), currentSelectedOption);
});

/* （任意）ホストが回答を取り消した時の復帰 */
connection.on('VoteDeleted', (clientId, deletedMultiplier) => {
    const myId = connection.connectionId;
    if (!myId || clientId !== myId) return;

    // このラウンドのロック解除（使用済みは BuildState の usedMultipliersByTeam に従う）
    hasVotedThisRound = false;
    currentSelectedOption = null;
    selectedMultiplier = 0;

    document.querySelectorAll('.choice').forEach(b => {
        b.disabled = false; b.classList.remove('selected-answer');
    });
    multipliersEl?.querySelectorAll('.multiplier-btn').forEach(b => {
        b.disabled = false; b.classList.remove('selected'); b.style.pointerEvents = ''; b.style.opacity = '';
    });
    text(msgEl, '回答が削除されました。もう一度回答できます');
    updateVoteButtons();

    // 最新状態を取り直して“使用済み倍率（ゲーム全体）”を再反映
    invoke('GetState');
});

/* 旧イベント互換 */
connection.on('QuestionChanged', (title, options) => {
    text(qTitle, title || '問題');
    renderChoices(Array.isArray(options) ? options : []);
    multipliersEl?.querySelectorAll('.multiplier-btn').forEach(b => b.classList.remove('selected'));
    hasVotedThisRound = false; currentSelectedOption = null; selectedMultiplier = 0;
    updateVoteButtons();
});

/* 接続開始 */
(async () => {
    try {
        await connection.start();
        setConn(true);

        // 1) まず状態を取得して UI 準備
        await invoke('GetState');

        // 2) その後にチーム名を送る（保存済みだけ）
        const t = getTeam();
        if (t) { await invoke('UpdateTeamName', t); }

    } catch (e) {
        console.error('SignalR connection error', e);
        setConn(false, '接続失敗');
    }
})();
