// ファイル: Hubs/VoteHub.cs
using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Configuration;

namespace GEChoice.Hubs
{
    public class VoteHub : Hub
    {
        // ====== 設問・状態 ======
        private static readonly object _lock = new();
        private static int _currentIndex = 0;

        // 設問は appsettings.json から読み込み（Title と Options(A/B)）
        private static List<Question> _questions = new()
        {
            new Question { Title = "第1問", Options = new[] { "A", "B" } },
            new Question { Title = "第2問", Options = new[] { "A", "B" } },
            new Question { Title = "第3問", Options = new[] { "A", "B" } }
        };

        // 投票受付フラグ・開始時刻
        private static volatile bool _isVotingOpen = false;
        private static DateTime? _votingStartTimeUtc = null;

        // 集計
        private static readonly ConcurrentDictionary<string, string> _answers = new(); // connId -> "A"/"B"
        private static readonly ConcurrentDictionary<string, ClientVote> _clientVotes = new(); // connId -> 詳細
        private static readonly ConcurrentDictionary<string, HashSet<int>> _usedMultipliers = new(); // connId -> {1,2,4}

        // 問題ごとの結果履歴（StopVoting時にスナップショット）
        private static readonly ConcurrentDictionary<int, List<QuestionResult>> _questionResults = new();

        private readonly IConfiguration _cfg;

        public VoteHub(IConfiguration cfg)
        {
            _cfg = cfg;

            // 初回だけ設定から設問ロード
            if (_questions.Count == 3 && _questions[0].Title == "第1問")
            {
                var qs = _cfg.GetSection("Voting:Questions").Get<List<AppSettingsQuestion>>();
                if (qs != null && qs.Count > 0)
                {
                    _questions = qs.Select(q => new Question
                    {
                        Title = q.Title ?? "",
                        Options = (q.Options ?? Array.Empty<string>())
                                 .Where(o => o is "A" or "B" or "C").ToArray()
                    }).ToList();

                    if (_questions.Count == 0)
                    {
                        _questions = new()
                        {
                            new Question { Title = "Q1", Options = new[] { "A","B" } },
                            new Question { Title = "Q2", Options = new[] { "A","B" } },
                            new Question { Title = "Q3", Options = new[] { "A","B" } }
                        };
                    }
                }
            }
        }

        // ====== Hub エンドポイント ======
        public override async Task OnConnectedAsync()
        {
            await Clients.Caller.SendAsync("StateUpdated", BuildState());
            await base.OnConnectedAsync();
        }

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            // 切断時は現在の回答を掃除
            _answers.TryRemove(Context.ConnectionId, out _);
            _clientVotes.TryRemove(Context.ConnectionId, out _);
            _usedMultipliers.TryRemove(Context.ConnectionId, out _);

            await Clients.All.SendAsync("StateUpdated", BuildState());
            await base.OnDisconnectedAsync(exception);
        }

        // 現在状態を取得（ページ初期表示で呼ばれる）
        public Task GetState() => Clients.Caller.SendAsync("StateUpdated", BuildState());

        // A/B のみ（倍率なし）で投票するシンプル版
        public async Task Submit(string label)
        {
            if (!_isVotingOpen) return;
            if (!IsValidOption(label)) return;

            var now = DateTime.UtcNow;
            _answers[Context.ConnectionId] = label;

            // チーム名など未指定でも最低限の形で記録
            var cv = _clientVotes.GetOrAdd(Context.ConnectionId, _ => new ClientVote
            {
                ClientId = Context.ConnectionId,
                TeamName = "",
                Multiplier = 1
            });
            cv.SelectedOption = label;
            cv.ResponseTime = CalcResponseSec(now);

            await Clients.All.SendAsync("StateUpdated", BuildState());
        }

        // 倍率・チーム名つきの投票（あなたのVote.cshtmlがこれを呼ぶ）
        public async Task SubmitWithMultiplier(string label, int multiplier, string? teamName)
        {
            if (!_isVotingOpen) return;
            if (!IsValidOption(label)) return;
            if (multiplier is not (1 or 2 or 4)) return;

            // 同一クライアントで各倍率は一度だけ
            var used = _usedMultipliers.GetOrAdd(Context.ConnectionId, _ => new HashSet<int>());
            lock (_lock)
            {
                if (used.Contains(multiplier)) return;
                used.Add(multiplier);
            }

            var now = DateTime.UtcNow;

            _answers[Context.ConnectionId] = label;
            _clientVotes[Context.ConnectionId] = new ClientVote
            {
                ClientId = Context.ConnectionId,
                TeamName = teamName ?? "",
                SelectedOption = label,
                Multiplier = multiplier,
                ResponseTime = CalcResponseSec(now)
            };

            await Clients.All.SendAsync("StateUpdated", BuildState());
            // クライアント側で倍率ボタンを無効化するため
            await Clients.Caller.SendAsync("MultiplierUsed", multiplier);
        }

        // 回答開始
        public async Task StartVoting()
        {
            _isVotingOpen = true;
            _votingStartTimeUtc = DateTime.UtcNow;
            await Clients.All.SendAsync("VotingStatusChanged", true);
        }

        // 回答終了（この時点で結果を確定・保存しておく）
        public async Task StopVoting()
        {
            _isVotingOpen = false;

            var snapshot = _clientVotes.Values
                .Select(v => new QuestionResult
                {
                    ClientId = v.ClientId,
                    TeamName = v.TeamName,
                    SelectedOption = v.SelectedOption,
                    Multiplier = v.Multiplier,
                    ResponseTime = v.ResponseTime,
                    Points = v.Multiplier // 得点の定義が未定のため、とりあえず倍率を得点として記録
                })
                .ToList();

            _questionResults[_currentIndex] = snapshot;

            await Clients.All.SendAsync("VotingStatusChanged", false);
            await Clients.All.SendAsync("QuestionResults", _currentIndex, snapshot);
        }

        // 次の問題へ
        public async Task NextQuestion()
        {
            _currentIndex = Math.Min(_currentIndex + 1, _questions.Count - 1);
            ClearPerQuestionBuffers();
            await Clients.All.SendAsync("StateUpdated", BuildState());
        }

        // 前の問題へ
        public async Task PrevQuestion()
        {
            _currentIndex = Math.Max(_currentIndex - 1, 0);
            ClearPerQuestionBuffers();
            await Clients.All.SendAsync("StateUpdated", BuildState());
        }

        // すべてリセット（ゲームリセット）
        public async Task ResetCounts()
        {
            _answers.Clear();
            _clientVotes.Clear();
            _usedMultipliers.Clear();
            _questionResults.Clear();

            _currentIndex = 0;
            _isVotingOpen = false;
            _votingStartTimeUtc = null;

            await Clients.All.SendAsync("StateUpdated", BuildState());
            await Clients.All.SendAsync("GameReset");
        }

        // 最終結果（ホストの「最終結果」ボタンから呼ばれる）
        public async Task GetGameResults()
        {
            // 問題ごとの結果を合算してランキングを作成
            var total = new Dictionary<string, (string Team, int Points, double Time)>();

            foreach (var kv in _questionResults)
            {
                foreach (var r in kv.Value)
                {
                    var key = r.TeamName?.Trim().Length > 0 ? r.TeamName! : r.ClientId!;
                    if (!total.TryGetValue(key, out var acc))
                        acc = (key, 0, 0);

                    acc.Points += r.Points;
                    acc.Time += r.ResponseTime;
                    total[key] = acc;
                }
            }

            var results = total
                .Select(x => new GameResult
                {
                    ClientId = x.Key, // チーム名があれば同じ値
                    TeamName = x.Value.Team,
                    TotalPoints = x.Value.Points,
                    TotalTime = x.Value.Time
                })
                .OrderByDescending(r => r.TotalPoints)
                .ThenBy(r => r.TotalTime)
                .ToList();

            // ホスト側はモーダルで表示、クライアント側は特に受け取っても害はない
            await Clients.All.SendAsync("GameResults", results);
        }

        // ホストの「削除」操作
        public async Task DeleteClientVote(string clientId)
        {
            if (_clientVotes.TryRemove(clientId, out var removed))
            {
                _answers.TryRemove(clientId, out _);

                // 使用済み倍率を元に戻せるよう、記録から外す
                if (_usedMultipliers.TryGetValue(clientId, out var set) && removed?.Multiplier is 1 or 2 or 4)
                {
                    lock (_lock) set.Remove(removed.Multiplier);
                }

                await Clients.All.SendAsync("VoteDeleted", clientId, removed?.Multiplier ?? 0);
                await Clients.All.SendAsync("StateUpdated", BuildState());
            }
        }

        // ====== 内部ヘルパ ======
        private bool IsValidOption(string label)
        {
            var q = _questions[_currentIndex];
            return q.Options.Contains(label, StringComparer.OrdinalIgnoreCase);
        }

        private static double CalcResponseSec(DateTime nowUtc)
        {
            if (_votingStartTimeUtc == null) return 0;
            return Math.Max(0, (nowUtc - _votingStartTimeUtc.Value).TotalSeconds);
        }

        private static void ClearPerQuestionBuffers()
        {
            _answers.Clear();
            _clientVotes.Clear();
            _usedMultipliers.Clear();
            _isVotingOpen = false;
            _votingStartTimeUtc = null;
        }

        private object BuildState()
        {
            var q = _questions[_currentIndex];

            // 票数を数える（A/B/C すべてに対応、Cが無い設問なら0のまま）
            var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (var o in q.Options) counts[o] = 0;
            foreach (var v in _answers.Values)
            {
                if (counts.ContainsKey(v)) counts[v]++;
            }

            // 参加者の回答状況（ホスト用テーブル）
            var clientVotes = _clientVotes.ToDictionary(
                kv => kv.Key,
                kv => new
                {
                    clientId = kv.Value.ClientId,
                    teamName = kv.Value.TeamName,
                    selectedOption = kv.Value.SelectedOption,
                    multiplier = kv.Value.Multiplier,
                    responseTime = kv.Value.ResponseTime
                });

            return new
            {
                currentIndex = _currentIndex,
                question = new { title = q.Title, options = q.Options.Select(o => new { label = o }) },
                counts,
                isVotingOpen = _isVotingOpen,
                votingStartTime = _votingStartTimeUtc,
                clientVotes
            };
        }

        // ====== モデル ======
        private class Question
        {
            public string Title { get; set; } = "";
            public string[] Options { get; set; } = Array.Empty<string>();
        }

        private class AppSettingsQuestion
        {
            public string? Title { get; set; }
            public string[]? Options { get; set; }
        }

        private class ClientVote
        {
            public string ClientId { get; set; } = "";
            public string TeamName { get; set; } = "";
            public string SelectedOption { get; set; } = "-";
            public int Multiplier { get; set; } = 1;
            public double ResponseTime { get; set; } = 0; // 秒
        }

        private class QuestionResult
        {
            public string ClientId { get; set; } = "";
            public string TeamName { get; set; } = "";
            public string SelectedOption { get; set; } = "-";
            public int Multiplier { get; set; } = 1;
            public double ResponseTime { get; set; } = 0;
            public int Points { get; set; } = 0;
        }

        private class GameResult
        {
            public string ClientId { get; set; } = "";
            public string TeamName { get; set; } = "";
            public int TotalPoints { get; set; }
            public double TotalTime { get; set; }
        }
    }
}
