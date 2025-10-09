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

/* ===== UID ===== */
const UID_KEY = 'gec_uid';
 function getStableUid() {
    let uid = localStorage.getItem(UID_KEY);
    if (!uid) {
            uid = (crypto?.randomUUID?.() || ('uid-' + Math.random().toString(36).slice(2) + Date.now().toString(36)));
            localStorage.setItem(UID_KEY, uid);
        }
    return uid;
}
const MY_UID = getStableUid();


/* ===== SignalR ===== */
const connection = new signalR.HubConnectionBuilder()
    .withUrl(`/hub/vote?uid=${encodeURIComponent(MY_UID)}`)
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
connection.onclose(() => setConn(false, 'オフライン'));

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
            document.querySelectorAll('.choice').forEach(b => b.classList.remove('selected-answer'));
            multipliersEl?.querySelectorAll('.multiplier-btn').forEach(b => b.classList.remove('selected'));
        } else {

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

        if (state?.myVote && typeof state.myVote.multiplier === 'number') {
            hasVotedThisRound = true;
            currentSelectedOption = state.myVote.selectedOption || null;
            lockAfterVote(Number(state.myVote.multiplier), currentSelectedOption || undefined);
        }

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
    const myUid = localStorage.getItem('gec_uid');
    if (clientId !== myId && clientId !== myUid) return;

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

/* ===== 回答一覧モーダル ===== */
connection.on('ShowPerQuestionResults', (index, rows) => {
    const $ = (id) => document.getElementById(id);
    const modal = $('answer-list-modal');
    const titleEl = $('answer-list-title');
    const questionEl = $('answer-list-question');
    const contentEl = $('answer-list-content');
    if (!modal || !contentEl) return;

    // --- helpers ---
    const esc = (s) =>
        String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

    const norm = (s) => String(s ?? '').trim().normalize('NFKC');
    const myTeam = norm(localStorage.getItem('gec_team_name') || '');

    // rows を選択肢ごとにグルーピング
    const groups = { A: [], B: [] };
    (Array.isArray(rows) ? rows : []).forEach((r) => {
        const opt = String(r?.selectedOption ?? r?.SelectedOption ?? '-').trim().toUpperCase();
        const team = norm(r?.teamName ?? r?.TeamName ?? '');
        const mul = Number(r?.multiplier ?? r?.Multiplier ?? 1) || 1;
        if (!team) return;
        if (opt === 'A' || opt === 'B') groups[opt].push({ team, mul });
    });

    const countA = groups.A.length;
    const countB = groups.B.length;
    if (titleEl) titleEl.textContent = `回答一覧（A: ${countA}チーム / B: ${countB}チーム）`;

    // 画面上の問題タイトルを拾えなければフォールバック
    const questionText =
        (typeof qTitle !== 'undefined' && qTitle?.textContent?.trim()) ||
        document.querySelector('#question-title')?.textContent?.trim() ||
        `問題${(Number.isFinite(index) ? index : 0) + 1}`;
    if (questionEl) questionEl.textContent = questionText;

    // パネルHTML生成
    const buildPanel = (opt) => {
        const list = groups[opt];
        const chips =
            list
                .map((x) => {
                    const isMine = myTeam && norm(x.team) === myTeam; // why: 全角/半角・空白ゆらぎ統一
                    const baseStyle = `
                        padding:8px 12px;
                        border:1px solid #e5e7eb;
                        border-radius:6px;
                        background:#fff;
                        font-weight:600;`.trim();
                    const cls = isMine ? 'my-team' : '';
                    return `
                        <div class="${cls}" style="${baseStyle}">
                            <span>${esc(x.team)}</span>
                            <span style="margin-left:8px;">×${esc(x.mul)}</span>
                        </div>`;
                })
                .join('') || `<div style="color:#999;">回答なし</div>`;

        return `
            <div style="margin-bottom:20px;padding:16px;background:#f9fafb;border-radius:8px;">
                <div style="font-size:18px;font-weight:700;color:#111;margin-bottom:12px;">
                    選択肢 ${opt} <span style="font-weight:400;color:#666;">(${list.length}件)</span>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:8px;">${chips}</div>
            </div>`;
    };

    contentEl.innerHTML = buildPanel('A') + buildPanel('B');

    // 表示
    modal.style.display = 'block';
});

// CSSは未注入時のみ追加
(function ensureMyTeamStyle() {
    if (document.getElementById('my-team-style')) return;
    const css = `
        .my-team{
            background:#fff8e1 !important;
            border-color:#f59e0b !important;
            box-shadow:0 0 0 2px rgba(245,158,11,.25);
        }
        .my-team span:first-child{ font-weight:800; }
    `;
    const s = document.createElement('style');
    s.id = 'my-team-style';
    s.textContent = css;
    document.head.appendChild(s);
})();


connection.on('ClosePerQuestionResults', () => {
    const modal = $('answer-list-modal');
    if (modal) modal.style.display = 'none';
});

/* ===== 最終結果モーダル ===== */
connection.on('GameResults', (results) => {
    const modal = $('final-results-modal');
    const content = $('final-results-content');
    if (!modal || !content) return;

    if (!results || results.length === 0) {
        content.innerHTML = '<p style="color:#999;">結果がありません</p>';
        modal.style.display = 'block';
        return;
    }

    let html = '<table style="width:100%;border-collapse:collapse;"><tr style="background:#f3f4f6;"><th style="padding:12px;text-align:left;">順位</th><th style="padding:12px;text-align:left;">チーム名</th><th style="padding:12px;text-align:right;">合計点数</th><th style="padding:12px;text-align:right;">合計時間(秒)</th></tr>';
    results.forEach((r, i) => {
        const rank = i + 1;
        const badge = rank === 1 ? ' 🏆' : (rank === 2 ? ' 🥈' : (rank === 3 ? ' 🥉' : ''));
        const team = (r.teamName || r.TeamName || '').trim();
        if (!team) return;
        const time = (r.totalTime || r.TotalTime || 0).toFixed(1);
        const points = r.totalPoints || r.TotalPoints || 0;
        html += `<tr style="border-bottom:1px solid #e5e7eb;"><td style="padding:12px;">${rank}${badge}</td><td style="padding:12px;">${team}</td><td style="padding:12px;text-align:right;">${points}点</td><td style="padding:12px;text-align:right;">${time}</td></tr>`;
    });
    html += '</table>';
    content.innerHTML = html;
    modal.style.display = 'block';
});

/* モーダル閉じるボタン */
const closeAnswerListBtn = $('close-answer-list');
if (closeAnswerListBtn) {
    closeAnswerListBtn.onclick = () => {
        const modal = $('answer-list-modal');
        if (modal) modal.style.display = 'none';
    };
}

const closeFinalResultsBtn = $('close-final-results');
if (closeFinalResultsBtn) {
    closeFinalResultsBtn.onclick = () => {
        const modal = $('final-results-modal');
        if (modal) modal.style.display = 'none';
    };
}

connection.on('GameReset', () => {
    // ラウンド内のロックや選択状態を全面解除
    hasVotedThisRound = false;
    currentSelectedOption = null;
    selectedMultiplier = 0;

    // A/B ボタンを再有効化 & 見た目リセット
    document.querySelectorAll('.choice').forEach(b => {
        b.disabled = false;
        b.classList.remove('selected-answer');
    });

    // 倍率ボタンも初期化（使用済みは後続の StateUpdated で反映される）
    multipliersEl?.querySelectorAll('.multiplier-btn').forEach(b => {
        b.disabled = false;
        b.classList.remove('used', 'selected');
        b.style.pointerEvents = '';
        b.style.opacity = '';
    });

    // 画面表示用メッセージ
    text(msgEl, 'リセットされました。チーム名を確認して点数を選択し、回答できます');

    // サーバ状態を取り直してUIを最新化（使用済み倍率・タイマー等）
    invoke('GetState');

    // Uid→Team がサーバ側でクリアされているため、チーム名を再送（ローカルは保持済）
    const t = getTeam();
    if (t) invoke('UpdateTeamName', t);

    // 最終的な活性化判定を再評価
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
