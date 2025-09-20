using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;

namespace GEChoice.Hubs
{
    // --- DTO ---
    public class VoteOption
    {
        public string Label { get; set; } = "";   // "A","B","C"
    }
    
    public class VoteQuestion
    {
        public string Title { get; set; } = "";
        public List<VoteOption> Options { get; set; } = new();
    }

    public class VoteState
    {
        public int CurrentIndex { get; set; }
        public VoteQuestion Question { get; set; } = new();
        public Dictionary<string, int> Counts { get; set; } = new();
        public bool IsVotingOpen { get; set; }
        public DateTime? VotingStartTime { get; set; }
        public Dictionary<string, ClientVoteData> ClientVotes { get; set; } = new();
        public List<string> ActiveClients { get; set; } = new();
        public List<TeamInfo> Teams { get; set; } = new(); // ★追加
    }

    public class TeamInfo
    {
        public string ClientId { get; set; } = "";
        public string TeamName { get; set; } = "";
    }

    public class ClientVoteData
    {
        public string ClientId { get; set; } = "";
        public string TeamName { get; set; } = "";
        public string SelectedOption { get; set; } = "";
        public int Multiplier { get; set; }
        public double ResponseTime { get; set; }
        public int Points { get; set; }
    }

    public class GameResult
    {
        public string ClientId { get; set; } = "";
        public string TeamName { get; set; } = "";
        public int TotalPoints { get; set; }
        public double TotalTime { get; set; }
        public Dictionary<int, ClientVoteData> QuestionResults { get; set; } = new();
    }

    public class VoteHub : Hub
    {
        private static readonly ConcurrentDictionary<string, string> _answers = new();
        private static readonly ConcurrentDictionary<string, string> _teamNames = new();
        private static readonly ConcurrentDictionary<string, List<int>> _usedMultipliers = new();
        private static readonly ConcurrentDictionary<int, ConcurrentDictionary<string, ClientVoteData>> _questionResults = new();
        private static readonly ConcurrentDictionary<string, DateTime> _voteStartTimes = new();
        private static int _currentIndex = 0;
        private static bool _isVotingOpen = false;
        private static DateTime? _votingStartTime = null;
        private readonly IConfiguration _config;
        
        // 正解リスト（問題1:A, 問題2:B, 問題3:A）
        private static readonly string[] _correctAnswers = { "A", "B", "A" };
        
        public VoteHub(IConfiguration config) => _config = config;

        private List<VoteQuestion> LoadQuestions()
        {
            var list = new List<VoteQuestion>();
            foreach (var q in _config.GetSection("Voting:Questions").GetChildren())
            {
                var item = new VoteQuestion { Title = q["Title"] ?? "問題" };

                var opts = new List<VoteOption>();
                foreach (var o in q.GetSection("Options").GetChildren())
                {
                    var s = o.Get<string?>();
                    if (!string.IsNullOrWhiteSpace(s))
                    {
                        opts.Add(new VoteOption { Label = s!.Trim() });
                        continue;
                    }
                    var label = o["Label"];
                    if (!string.IsNullOrWhiteSpace(label))
                        opts.Add(new VoteOption { Label = label.Trim() });
                }

                item.Options = opts
                    .Where(x => x.Label is "A" or "B" or "C")
                    .DistinctBy(x => x.Label)
                    .ToList();

                if (item.Options.Count < 2)
                    item.Options = new() { new() { Label = "A" }, new() { Label = "B" } };

                list.Add(item);
            }

            if (list.Count == 0)
                list.Add(new VoteQuestion { Title = "サンプル", Options = new() { new() { Label = "A" }, new() { Label = "B" } } });

            return list;
        }

        private VoteQuestion CurrentQuestion(List<VoteQuestion> qs)
            => qs[Math.Clamp(_currentIndex, 0, qs.Count - 1)];

        public override async Task OnConnectedAsync()
        {
            await base.OnConnectedAsync();
            await Clients.Caller.SendAsync("StateUpdated", BuildState());
        }

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            _answers.TryRemove(Context.ConnectionId, out _);
            _teamNames.TryRemove(Context.ConnectionId, out _);
            _voteStartTimes.TryRemove(Context.ConnectionId, out _);
            await Clients.All.SendAsync("StateUpdated", BuildState());
            await base.OnDisconnectedAsync(exception);
        }

        public Task<VoteState> GetState() => Task.FromResult(BuildState());

        // 回答開始ボタン
        public async Task StartVoting()
        {
            _isVotingOpen = true;
            _votingStartTime = DateTime.Now;
            _answers.Clear();
            _voteStartTimes.Clear();
            await Clients.All.SendAsync("VotingStatusChanged", true);
            await Clients.All.SendAsync("StateUpdated", BuildState());
        }

        // 回答終了ボタン
        public async Task StopVoting()
        {
            _isVotingOpen = false;
            
            // 現在の問題の結果を保存
            if (!_questionResults.ContainsKey(_currentIndex))
                _questionResults[_currentIndex] = new ConcurrentDictionary<string, ClientVoteData>();
            
            // 正解を取得
            string correctAnswer = _currentIndex < _correctAnswers.Length ? _correctAnswers[_currentIndex] : "";
            
            // 各クライアントの投票データを集計
            foreach (var kvp in _answers)
            {
                var clientId = kvp.Key;
                var selectedOption = kvp.Value;
                
                // 回答時間を計算
                double responseTime = 0;
                if (_voteStartTimes.TryGetValue(clientId, out var startTime) && _votingStartTime.HasValue)
                {
                    responseTime = (startTime - _votingStartTime.Value).TotalSeconds;
                }
                
                // 倍率を取得（デフォルト1）
                var parts = selectedOption.Split('|');
                var option = parts[0];
                var multiplier = parts.Length > 1 && int.TryParse(parts[1], out var m) ? m : 1;
                
                // 正解判定して点数を計算
                bool isCorrect = option == correctAnswer;
                int points = isCorrect ? multiplier : 0;
                
                var voteData = new ClientVoteData
                {
                    ClientId = clientId,
                    TeamName = _teamNames.TryGetValue(clientId, out var team) ? team : clientId.Substring(0, Math.Min(8, clientId.Length)),
                    SelectedOption = option,
                    Multiplier = multiplier,
                    ResponseTime = responseTime,
                    Points = points
                };
                
                _questionResults[_currentIndex][clientId] = voteData;
            }
            
            await Clients.All.SendAsync("VotingStatusChanged", false);
            await Clients.All.SendAsync("QuestionResults", _currentIndex, _questionResults[_currentIndex].Values.ToList());
            await Clients.All.SendAsync("StateUpdated", BuildState());
        }

        // チーム名を設定
        public async Task SetTeamName(string teamName)
        {
            if (!string.IsNullOrWhiteSpace(teamName))
            {
                _teamNames[Context.ConnectionId] = teamName;
                await Clients.All.SendAsync("StateUpdated", BuildState());
            }
        }

        // クライアントからの投票（倍率付き）
        public async Task SubmitWithMultiplier(string label, int multiplier, string teamName = null!)
        {
            if (!_isVotingOpen) return;
            
            var qs = LoadQuestions();
            var valid = CurrentQuestion(qs).Options.Select(o => o.Label).ToHashSet(StringComparer.Ordinal);
            if (!valid.Contains(label)) return;
            
            // 倍率の検証（1, 2, 4のみ、既に使用済みでないか）
            if (!new[] { 1, 2, 4 }.Contains(multiplier)) return;
            
            var clientId = Context.ConnectionId;
            if (!_usedMultipliers.ContainsKey(clientId))
                _usedMultipliers[clientId] = new List<int>();
            
            if (_usedMultipliers[clientId].Contains(multiplier)) return;
            
            // チーム名を更新
            if (!string.IsNullOrWhiteSpace(teamName))
            {
                _teamNames[clientId] = teamName;
            }
            
            // 投票を記録
            _answers[clientId] = $"{label}|{multiplier}";
            _usedMultipliers[clientId].Add(multiplier);
            
            // 投票開始時刻を記録
            if (!_voteStartTimes.ContainsKey(clientId))
                _voteStartTimes[clientId] = DateTime.Now;
            
            await Clients.All.SendAsync("StateUpdated", BuildState());
            await Clients.Caller.SendAsync("MultiplierUsed", multiplier);
        }

        public async Task Submit(string label)
        {
            await SubmitWithMultiplier(label, 1);
        }

        // 特定のクライアントの回答を削除
        public async Task DeleteClientVote(string clientId)
        {
            // 削除される回答の倍率を取得
            int deletedMultiplier = 1;
            if (_answers.TryGetValue(clientId, out var answer))
            {
                var parts = answer.Split('|');
                if (parts.Length > 1 && int.TryParse(parts[1], out var m))
                {
                    deletedMultiplier = m;
                }
            }
            
            _answers.TryRemove(clientId, out _);
            _voteStartTimes.TryRemove(clientId, out _);
            
            // 削除された倍率を使用済みリストから削除
            if (_usedMultipliers.TryGetValue(clientId, out var multipliers))
            {
                multipliers.Remove(deletedMultiplier);
            }
            
            // 現在の問題の結果からも削除
            if (_questionResults.TryGetValue(_currentIndex, out var results))
            {
                results.TryRemove(clientId, out _);
            }
            
            await Clients.All.SendAsync("StateUpdated", BuildState());
            await Clients.All.SendAsync("VoteDeleted", clientId, deletedMultiplier);
        }

        public async Task ResetCounts()
        {
            _answers.Clear();
            _teamNames.Clear();
            _usedMultipliers.Clear();
            _questionResults.Clear();
            _voteStartTimes.Clear();
            _isVotingOpen = false;
            _votingStartTime = null;
            await Clients.All.SendAsync("StateUpdated", BuildState());
            await Clients.All.SendAsync("GameReset"); // クライアントにリセット通知を送信
        }

        public async Task SetQuestion(int index)
        {
            // 回答受付中の場合は移動を禁止
            if (_isVotingOpen)
            {
                await Clients.Caller.SendAsync("ShowAlert", "回答終了ボタンを押してから次の問題に進んでください。");
                return;
            }
            
            var qs = LoadQuestions();
            _currentIndex = Math.Clamp(index, 0, qs.Count - 1);
            _answers.Clear();
            _voteStartTimes.Clear();
            _isVotingOpen = false;
            _votingStartTime = null;
            await Clients.All.SendAsync("StateUpdated", BuildState());
        }

        public Task PrevQuestion() => SetQuestion(_currentIndex - 1);
        public Task NextQuestion() => SetQuestion(_currentIndex + 1);

        // 最終結果を取得
        public async Task GetGameResults()
        {
            var results = new List<GameResult>();
            var allClients = new HashSet<string>();
            
            foreach (var qr in _questionResults)
            {
                foreach (var clientId in qr.Value.Keys)
                    allClients.Add(clientId);
            }
            
            foreach (var clientId in allClients)
            {
                var result = new GameResult 
                { 
                    ClientId = clientId,
                    TeamName = _teamNames.TryGetValue(clientId, out var team) ? team : clientId.Substring(0, Math.Min(8, clientId.Length))
                };
                
                foreach (var kvp in _questionResults)
                {
                    if (kvp.Value.TryGetValue(clientId, out var voteData))
                    {
                        result.QuestionResults[kvp.Key] = voteData;
                        result.TotalPoints += voteData.Points;
                        result.TotalTime += voteData.ResponseTime;
                    }
                }
                
                results.Add(result);
            }
            
            // 点数の高い順、同点の場合は時間の早い順でソート
            results = results.OrderByDescending(r => r.TotalPoints)
                           .ThenBy(r => r.TotalTime)
                           .ToList();
            
            await Clients.All.SendAsync("GameResults", results);
        }

        private VoteState BuildState()
        {
            var qs = LoadQuestions();
            var q = CurrentQuestion(qs);

            var valid = q.Options.Select(o => o.Label).ToHashSet(StringComparer.Ordinal);
            var counts = _answers.Values
                .Select(v => v.Split('|')[0])
                .Where(v => valid.Contains(v))
                .GroupBy(v => v)
                .ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);

            foreach (var o in q.Options)
                if (!counts.ContainsKey(o.Label)) counts[o.Label] = 0;

            var clientVotes = new Dictionary<string, ClientVoteData>();
            foreach (var kvp in _answers)
            {
                var parts = kvp.Value.Split('|');
                double responseTime = 0;
                if (_voteStartTimes.TryGetValue(kvp.Key, out var startTime) && _votingStartTime.HasValue)
                {
                    responseTime = (startTime - _votingStartTime.Value).TotalSeconds;
                }
                
                clientVotes[kvp.Key] = new ClientVoteData
                {
                    ClientId = kvp.Key,
                    TeamName = _teamNames.TryGetValue(kvp.Key, out var team) ? team : kvp.Key.Substring(0, Math.Min(8, kvp.Key.Length)),
                    SelectedOption = parts[0],
                    Multiplier = parts.Length > 1 && int.TryParse(parts[1], out var m) ? m : 1,
                    ResponseTime = responseTime
                };
            }

            return new VoteState
            {
                CurrentIndex = _currentIndex,
                Question = q,
                Counts = counts,
                IsVotingOpen = _isVotingOpen,
                VotingStartTime = _votingStartTime,
                ClientVotes = clientVotes,
                ActiveClients = _answers.Keys.ToList(),
                Teams = _teamNames.Select(x => new TeamInfo { ClientId = x.Key, TeamName = x.Value }).ToList() // ★追加
            };
        }
    }
}