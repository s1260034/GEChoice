using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Configuration;

namespace GEChoice.Hubs
{
    public class VoteHub : Hub
    {
        // =====================
        // フィールド
        // =====================
        // ----- 接続／制御 -----
        private static readonly object _lock = new();                           // 接続デバイスの確立（保護）
        private static readonly SemaphoreSlim _finalizeSemaphore = new(1, 1);   // 回答確定処理の多重実行を防ぐための制御

        // ----- フラグ -----
        private static volatile bool _isVotingOpen = false;                              // 回答受付可否フラグ
        private static DateTime? _votingStartUtc = null;                                 // 回答時間の計測開始フラグ
        private static readonly ConcurrentDictionary<int, bool> _resultsShown = new();   // 設問ごとの回答一覧モーダル表示済み確認フラグ

        // ----- 設問 -----
        private readonly IConfiguration _cfg;              // appsettings.json呼び出し（設問の上書き書き込みに使用）
        private static int _currentIndex = 0;              // 現在の設問インデックス
        private static List<Question> _questions = new()   // 設問リスト
        {
            new Question { Title = "第1問", Options = new[] { "A", "B" }, CorrectOption = "A" },
            new Question { Title = "第2問", Options = new[] { "A", "B" }, CorrectOption = "A" },
            new Question { Title = "第3問", Options = new[] { "A", "B" }, CorrectOption = "A" }
        };

        // ----- 投票 -----
        private static readonly ConcurrentDictionary<string, string> _answers = new();                // 現在の投票（A or B）
        private static readonly ConcurrentDictionary<string, ClientVote> _clientVotes = new();        // 現在の投票詳細（チーム名、倍率、回答時間）
        private static readonly ConcurrentDictionary<string, HashSet<int>> _usedMultipliers = new();  // 使用済み倍率の管理（キーはチーム名）

        // ----- 途中経過／結果 -----
        private static readonly ConcurrentDictionary<string, (int Points, double Time)> _aggregateTotals = new();   // 途中経過の合計（Pointsは累計得点、Timeは累計回答時間）
        private static readonly ConcurrentDictionary<int, List<QuestionResult>> _questionResults = new();           // 設問の確定結果一覧（回答終了時に保存）

        // ----- チーム名 -----
        private static string NormalizeTeam(string? s) => (s ?? "").Trim();                 // 正規化（大文字小文字は保持）
        private static readonly ConcurrentDictionary<string, string?> _teamNames = new();   // 接続IDからチーム名の紐付け
        private static readonly ConcurrentDictionary<string, byte> _connections = new();    // 接続確認用（IDをセット、値はダミー）


        // =====================
        // コンストラクタ
        // =====================
        public VoteHub(IConfiguration cfg)
        {
            _cfg = cfg;

            // 設定から設問/正解を読み込む（Voting:Questions:[{Title, Options, Answer}]）
            var qs = _cfg.GetSection("Voting:Questions").Get<List<AppSettingsQuestion>>();
            if (qs != null && qs.Count > 0)
            {
                var list = new List<Question>();
                foreach (var q in qs)
                {
                    var opts = (q.Options ?? Array.Empty<string>())
                                .Where(o => o is "A" or "B" or "C")
                                .ToArray();
                    if (opts.Length == 0) continue;

                    list.Add(new Question
                    {
                        Title = q.Title ?? "",
                        Options = opts,
                        CorrectOption = (q.Answer ?? "").Trim().ToUpperInvariant()
                    });
                }
                if (list.Count > 0) _questions = list;
            }
        }


        // =====================
        // ユーティリティ
        // =====================
        // ホスト判定
        private bool IsHost()
        {
            var http = Context.GetHttpContext();
            return http?.Request.Cookies.TryGetValue("gec_host", out var v) == true && v == "ok";
        }

        // VoteHubの実行サイクル
        public override async Task OnConnectedAsync()
        {
            _connections[Context.ConnectionId] = 1;
            await Clients.Caller.SendAsync("StateUpdated", BuildState());
            await BroadcastParticipants();
            await base.OnConnectedAsync();
        }

        // 切断時の処理（個別回答の削除、状態と参加者一覧の更新）
        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            _answers.TryRemove(Context.ConnectionId, out _);
            _clientVotes.TryRemove(Context.ConnectionId, out _);
            // _usedMultipliers は teamName キーなので、切断では削除しない
            _teamNames.TryRemove(Context.ConnectionId, out _);
            _connections.TryRemove(Context.ConnectionId, out _);

            await Clients.All.SendAsync("StateUpdated", BuildState());
            await BroadcastParticipants();
            await base.OnDisconnectedAsync(exception);
        }


        // =====================
        // クライアント → サーバー処理
        // =====================
        // ---------------
        // 共通
        // ---------------
        // 状態取得（初期描画、再接続時）
        public Task GetState() => Clients.Caller.SendAsync("StateUpdated", BuildState());

        // ---------------
        // 参加者ページ用
        // ---------------
        // チーム名の登録／更新
        public async Task UpdateTeamName(string teamName)
        {
            _teamNames[Context.ConnectionId] = (teamName ?? "").Trim();
            await Clients.Caller.SendAsync("StateUpdated", BuildState());
            await BroadcastParticipants();
        }

        // 回答送信（A or B）
        public async Task Submit(string label)
        {
            if (!_isVotingOpen) return;
            if (!IsValidOption(label)) return;

            _answers[Context.ConnectionId] = label;
            await Clients.All.SendAsync("StateUpdated", BuildState());
        }

        // 回答送信（詳細情報）
        public async Task SubmitWithMultiplier(string label, int multiplier, string? teamName)
        {
            if (!_isVotingOpen) return;
            if (!IsValidOption(label)) return;
            if (multiplier is not (1 or 2 or 4)) return;

            var team = NormalizeTeam(teamName);
            if (string.IsNullOrEmpty(team))
            {
                await Clients.Caller.SendAsync("ShowAlert", "チーム名を入力してください。");
                return;
            }
            _teamNames[Context.ConnectionId] = team;

            var used = _usedMultipliers.GetOrAdd(team, _ => new HashSet<int>());

            bool alreadyUsed;
            lock (_lock)                // ← 同期区間は「見る/入れる」だけ
            {
                alreadyUsed = used.Contains(multiplier);
                if (!alreadyUsed)
                {
                    used.Add(multiplier);
                }
            }

            if (alreadyUsed)
            {
                // ← await は lock の外で
                await Clients.Caller.SendAsync("MultiplierAlreadyUsed", multiplier);
                return;
            }

            var rt = _votingStartUtc.HasValue
                ? (DateTime.UtcNow - _votingStartUtc.Value).TotalSeconds
                : 0d;

            _answers[Context.ConnectionId] = label;
            _clientVotes[Context.ConnectionId] = new ClientVote
            {
                ClientId = Context.ConnectionId,
                TeamName = team,
                SelectedOption = label,
                Multiplier = multiplier,
                ResponseTime = rt
            };

            await Clients.All.SendAsync("StateUpdated", BuildState());
            await Clients.All.SendAsync("ParticipantsUpdated", BuildParticipants());
            await Clients.Caller.SendAsync("MultiplierUsed", multiplier);
        }

        // ---------------
        // ホストページ用
        // ---------------
        // 「回答開始ボタン」処理
        public async Task StartVoting()
        {
            if (!IsHost()) { await Clients.Caller.SendAsync("ShowAlert", "権限がありません"); return; }

            _isVotingOpen = true;
            _votingStartUtc = DateTime.UtcNow; // ★ 計測開始
            await Clients.All.SendAsync("VotingStatusChanged", true);
        }

        // 「回答終了ボタン」処理
        public async Task StopVoting()
        {
            if (!IsHost()) { await Clients.Caller.SendAsync("ShowAlert", "権限がありません"); return; }

            await FinalizeCurrentQuestionAsync(broadcastModal: true);
        }

        // 「次の問題へ」ボタン処理
        public async Task NextQuestion()
        {
            if (!IsHost()) { await Clients.Caller.SendAsync("ShowAlert", "権限がありません"); return; }

            if (_isVotingOpen)
            {
                await Clients.Caller.SendAsync("ShowAlert", "回答を終了してから次の問題へ進んでください。");
                return;
            }
            if (!_questionResults.ContainsKey(_currentIndex))
            {
                await Clients.Caller.SendAsync("ShowAlert", "先に「回答終了」を押してください。");
                return;
            }
            if (!_resultsShown.TryGetValue(_currentIndex, out var shown) || !shown)
            {
                await Clients.Caller.SendAsync("ShowAlert", "先に「回答一覧」を表示してください。");
                return;
            }

            _currentIndex = Math.Min(_currentIndex + 1, _questions.Count - 1);
            ClearPerQuestionBuffers();
            await Clients.All.SendAsync("ClosePerQuestionResults"); // モーダルを閉じる（全員）
            await Clients.All.SendAsync("StateUpdated", BuildState());
            await BroadcastParticipants();
        }

        // 「前の問題へ」ボタン処理
        public async Task PrevQuestion()
        {
            if (!IsHost()) { await Clients.Caller.SendAsync("ShowAlert", "権限がありません"); return; }

            if (_isVotingOpen)
            {
                await Clients.Caller.SendAsync("ShowAlert", "回答を終了してから前の問題へ戻ってください。");
                return;
            }
            _currentIndex = Math.Max(_currentIndex - 1, 0);
            ClearPerQuestionBuffers();
            await Clients.All.SendAsync("ClosePerQuestionResults");
            await Clients.All.SendAsync("StateUpdated", BuildState());
            await BroadcastParticipants();
        }

        // 「最終結果」ボタン処理
        public async Task GetGameResults()
        {
            if (!IsHost()) { await Clients.Caller.SendAsync("ShowAlert", "権限がありません"); return; }

            // ★ 最終問題かつ回答終了（=確定スナップショットあり）でなければ不可
            var lastIndex = _questions.Count - 1;
            if (_currentIndex != lastIndex)
            {
                await Clients.Caller.SendAsync("ShowAlert", "最終問題でのみ表示できます。");
                return;
            }
            if (_isVotingOpen)
            {
                await Clients.Caller.SendAsync("ShowAlert", "最後の問題を「回答終了」してください。");
                return;
            }
            if (!_questionResults.ContainsKey(lastIndex))
            {
                await Clients.Caller.SendAsync("ShowAlert", "最後の問題を「回答終了」してください。");
                return;
            }

            var results = CalcRunningTotals();
            await Clients.All.SendAsync("GameResults", results);
        }

        // 「回答一覧」ボタン処理
        public async Task ShowQuestionResults()
        {
            if (!IsHost()) { await Clients.Caller.SendAsync("ShowAlert", "権限がありません"); return; }

            if (!_questionResults.TryGetValue(_currentIndex, out var snapshot) || snapshot == null)
            {
                await Clients.Caller.SendAsync("ShowAlert", "先に「回答終了」を押してください。");
                return;
            }
            _resultsShown[_currentIndex] = true; // 表示済み
            await Clients.All.SendAsync("ShowPerQuestionResults", _currentIndex, snapshot); // 全員へ
        }

        // 「リセット」ボタン処理
        public async Task ResetCounts()
        {
            if (!IsHost()) { await Clients.Caller.SendAsync("ShowAlert", "権限がありません"); return; }

            _answers.Clear();
            _clientVotes.Clear();
            _usedMultipliers.Clear();   // ★ゲーム全体のリセット時だけクリア
            _questionResults.Clear();
            _aggregateTotals.Clear();
            _resultsShown.Clear();
            _isVotingOpen = false;
            _votingStartUtc = null;

            await Clients.All.SendAsync("StateUpdated", BuildState());
            await Clients.All.SendAsync("GameReset");
            await BroadcastInterimTotals();
            await BroadcastParticipants();
        }

        // 回答状況「削除」ボタン処理
        public async Task DeleteTeamVote(string teamName)
        {
            if (!IsHost()) { await Clients.Caller.SendAsync("ShowAlert", "権限がありません"); return; }
            if (string.IsNullOrWhiteSpace(teamName)) return;
            var team = NormalizeTeam(teamName);

            var toRemove = _clientVotes
                .Where(kv => string.Equals(NormalizeTeam(kv.Value.TeamName), team, StringComparison.Ordinal))
                .Select(kv => (id: kv.Key, mult: kv.Value.Multiplier))
                .ToList();

            foreach (var (id, mult) in toRemove)
            {
                _clientVotes.TryRemove(id, out _);
                _answers.TryRemove(id, out _);
                if (_usedMultipliers.TryGetValue(team, out var set) && (mult is 1 or 2 or 4))
                {
                    lock (_lock) set.Remove(mult);
                }
                await Clients.All.SendAsync("VoteDeleted", id, mult);
            }

            // すでに確定済みなら、同設問スナップショットからも削除 & 途中経過から減算
            if (_questionResults.TryGetValue(_currentIndex, out var snap) && snap != null)
            {
                var removedRows = snap
                    .Where(r => string.Equals((r.TeamName ?? "").Trim(), teamName.Trim(), StringComparison.Ordinal))
                    .ToList();

                if (removedRows.Count > 0)
                {
                    snap.RemoveAll(r => string.Equals((r.TeamName ?? "").Trim(), teamName.Trim(), StringComparison.Ordinal));

                    var key = teamName.Trim();
                    foreach (var r in removedRows)
                    {
                        if (r.Points <= 0) continue; // 正解で加点されていない分は減算不要（時間は合計のままでも差は出ない）
                        _aggregateTotals.AddOrUpdate(key,
                            _ => (0, 0d),
                            (_, cur) => (Math.Max(0, cur.Points - r.Points), cur.Time));
                    }

                    await Clients.All.SendAsync("QuestionResults", _currentIndex, snap);
                    await BroadcastInterimTotals(); // 減算を反映
                }
            }

            await Clients.All.SendAsync("StateUpdated", BuildState());
            await Clients.All.SendAsync("ParticipantsUpdated", BuildParticipants());
        }


        // =====================
        // ページ内処理
        // =====================
        // 現在の設問に対してのラベルの整合性判別
        private bool IsValidOption(string label)
        {
            var q = _questions[_currentIndex];
            return q.Options.Contains(label, StringComparer.OrdinalIgnoreCase);
        }

        // 設問切り替え時のバッファ削除
        private static void ClearPerQuestionBuffers()
        {
            _answers.Clear();
            _clientVotes.Clear();
            // _usedMultipliers はクリアしない：ゲーム通期で 1/2/4 を各1回にするルール想定
            _isVotingOpen = false;
            _votingStartUtc = null;
        }

        // 最終結果の集計
        private List<GameResult> CalcRunningTotals()
        {
            var total = new Dictionary<string, (string Team, int Points, double Time)>();

            foreach (var kv in _questionResults)
            {
                foreach (var r in kv.Value)
                {
                    var key = (r.TeamName ?? "").Trim();
                    if (string.IsNullOrEmpty(key)) continue;

                    if (!total.TryGetValue(key, out var acc)) acc = (key, 0, 0d);
                    acc.Points += r.Points;     // 正解ポイント
                    acc.Time += r.ResponseTime; // タイブレーク用：累積時間（秒）
                    total[key] = acc;
                }
            }

            // 途中経過にだけいる 0 点チームも最終結果に載せる（時間も反映）
            foreach (var kv in _aggregateTotals)
            {
                var key = kv.Key.Trim();
                if (!total.ContainsKey(key))
                {
                    total[key] = (key, 0, kv.Value.Time);
                }
            }

            return total.Select(x => new GameResult
            {
                ClientId = "",
                TeamName = x.Value.Team,
                TotalPoints = x.Value.Points,
                TotalTime = x.Value.Time
            })
            .OrderByDescending(r => r.TotalPoints)
            .ThenBy(r => r.TotalTime)   // 同点は時間が短い方を上位
            .ThenBy(r => r.TeamName, StringComparer.Ordinal)
            .ToList();
        }

        // ---------------
        // ブロードキャスト
        // ---------------
        // 回答確定処理（成否判別、結果一覧、途中経過、モーダル表示）
        private async Task FinalizeCurrentQuestionAsync(bool broadcastModal)
        {
            await _finalizeSemaphore.WaitAsync();
            try
            {
                if (!_isVotingOpen && _questionResults.ContainsKey(_currentIndex))
                {
                    return; // 二重確定防止
                }

                _isVotingOpen = false;

                var correct = (_questions.ElementAtOrDefault(_currentIndex)?.CorrectOption ?? "").ToUpperInvariant();

                var snapshot = _clientVotes.Values
                    .Select(v =>
                    {
                        var isCorrect = !string.IsNullOrEmpty(correct)
                                        && string.Equals(v.SelectedOption, correct, StringComparison.OrdinalIgnoreCase);
                        return new QuestionResult
                        {
                            ClientId = v.ClientId,
                            TeamName = v.TeamName,
                            SelectedOption = v.SelectedOption,
                            Multiplier = v.Multiplier,
                            ResponseTime = Math.Max(0, v.ResponseTime),     // 個別の回答時間（秒）
                            Points = isCorrect ? v.Multiplier : 0
                        };
                    })
                    .ToList();

                _questionResults[_currentIndex] = snapshot;

                // 途中経過（ポイント加算・時間は合計。0点でも存在は反映）
                foreach (var r in snapshot)
                {
                    var key = (r.TeamName ?? "").Trim();
                    if (string.IsNullOrEmpty(key)) continue;

                    _aggregateTotals.AddOrUpdate(key,
                        _ => (r.Points, r.ResponseTime),
                        (_, cur) => (cur.Points + r.Points, cur.Time + r.ResponseTime));
                }

                await Clients.All.SendAsync("VotingStatusChanged", false);
                await Clients.All.SendAsync("QuestionResults", _currentIndex, snapshot);
                if (broadcastModal)
                {
                    _resultsShown[_currentIndex] = true;
                    await Clients.All.SendAsync("ShowPerQuestionResults", _currentIndex, snapshot);
                }
                await BroadcastInterimTotals();
            }
            finally
            {
                _finalizeSemaphore.Release();
            }
        }

        // 途中経過
        private Task BroadcastInterimTotals()
        {
            var list = _aggregateTotals
                .Select(kv => new
                {
                    teamName = kv.Key,
                    totalPoints = kv.Value.Points,
                    totalTime = kv.Value.Time
                })
                .OrderByDescending(x => x.totalPoints)
                .ThenBy(x => x.totalTime)               // 途中経過も同じ並び方に
                .ThenBy(x => x.teamName, StringComparer.Ordinal)
                .ToList();

            return Clients.All.SendAsync("InterimTotalsUpdated", list);
        }

        // 参加者一覧
        private async Task BroadcastParticipants()
        {
            await Clients.All.SendAsync("ParticipantsUpdated", BuildParticipants());
        }

        // 参加者の回答反映
        private List<object> BuildParticipants()
        {
            // 回答済みの最新状態をチーム名で集約（無名は除外）
            var groupedAnswered = _clientVotes.Values
                .Where(v => !string.IsNullOrWhiteSpace(v.TeamName))
                .GroupBy(v => (v.TeamName ?? "").Trim())
                .ToDictionary(
                    g => g.Key,
                    g => {
                        var v = g.Last();
                        return new
                        {
                            selectedOption = v.SelectedOption,
                            multiplier = v.Multiplier,
                            responseTime = v.ResponseTime
                        };
                    });

            // 表示対象のチーム名（明示登録 + 投票で出現 + 途中経過0点のチーム）
            var teamSet = new HashSet<string>(StringComparer.Ordinal);
            foreach (var kv in _teamNames)
            {
                var name = (kv.Value ?? "").Trim();
                if (!string.IsNullOrEmpty(name)) teamSet.Add(name);
            }
            foreach (var v in _clientVotes.Values)
            {
                var name = (v.TeamName ?? "").Trim();
                if (!string.IsNullOrEmpty(name)) teamSet.Add(name);
            }
            foreach (var name in _aggregateTotals.Keys)
            {
                if (!string.IsNullOrWhiteSpace(name)) teamSet.Add(name.Trim());
            }

            var participants = teamSet
                .Select(team =>
                {
                    var has = groupedAnswered.TryGetValue(team, out var ans);
                    return new
                    {
                        teamName = team,
                        hasAnswered = has,
                        selectedOption = has ? ans!.selectedOption : "-",
                        multiplier = has ? ans!.multiplier : 0,
                        responseTime = has ? ans!.responseTime : 0d
                    };
                })
                .OrderBy(p => p.teamName, StringComparer.Ordinal)
                .Cast<object>()
                .ToList();

            return participants;
        }

        // クライアントへ配信する現在の状態の情報設定
        private object BuildState()
        {
            var q = _questions[_currentIndex];

            var counts = new Dictionary<string, int> { { "A", 0 }, { "B", 0 } };
            foreach (var v in _answers.Values)
                if (counts.ContainsKey(v)) counts[v]++;

            // クライアント投票（チーム名で集約）
            var grouped = _clientVotes.Values
                .Where(v => !string.IsNullOrWhiteSpace(v.TeamName))
                .GroupBy(v => (v.TeamName ?? "").Trim())
                .ToDictionary(
                    g => g.Key,
                    g => {
                        var v = g.Last();
                        return new
                        {
                            clientId = "",
                            teamName = g.Key,
                            selectedOption = v.SelectedOption,
                            multiplier = v.Multiplier,
                            responseTime = v.ResponseTime
                        };
                    });

            // ★ 追加: 使われた点数（1/2/4）のスナップショットをチーム単位で配信
            // HashSet の列挙は lock して配信用に配列へコピー
            Dictionary<string, int[]> usedByTeam;
            lock (_lock)
            {
                usedByTeam = _usedMultipliers.ToDictionary(
                    kv => kv.Key,
                    kv => kv.Value.ToArray()
                );
            }

            return new
            {
                currentIndex = _currentIndex,
                totalQuestions = _questions.Count,
                question = new { title = q.Title, options = q.Options.Select(o => new { label = o }) },
                counts,
                isVotingOpen = _isVotingOpen,
                votingStartTime = _votingStartUtc,
                clientVotes = grouped,

                // ★ 追加フィールド
                usedMultipliersByTeam = usedByTeam
            };
        }

        // =====================
        // 型／定義
        // =====================
        // 設問
        private class Question
        {
            public string Title { get; set; } = "";
            public string[] Options { get; set; } = Array.Empty<string>();
            public string? CorrectOption { get; set; }  // "A" / "B" / "C"
        }

        // appsettings.json読み込み用
        private class AppSettingsQuestion
        {
            public string? Title { get; set; }
            public string[]? Options { get; set; }
            public string? Answer { get; set; }         // "A" / "B" / "C"
        }

        // クライアントの回答データ
        private class ClientVote
        {
            public string ClientId { get; set; } = "";
            public string TeamName { get; set; } = "";
            public string SelectedOption { get; set; } = "-";
            public int Multiplier { get; set; } = 1;
            public double ResponseTime { get; set; } = 0;
        }

        // 回答確定時の一覧表示
        private class QuestionResult
        {
            public string ClientId { get; set; } = "";
            public string TeamName { get; set; } = "";
            public string SelectedOption { get; set; } = "-";
            public int Multiplier { get; set; } = 1;
            public double ResponseTime { get; set; } = 0;
            public int Points { get; set; } = 0;
        }

        // 最終結果表示
        private class GameResult
        {
            public string ClientId { get; set; } = "";
            public string TeamName { get; set; } = "";
            public int TotalPoints { get; set; }
            public double TotalTime { get; set; }
        }
    }
}
