using GEChoice.Hubs;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorPages();
builder.Services.AddSignalR();
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

// === Host gate ===
app.MapGet("/host-login", async ctx =>
{
    var html = """
        <!doctype html><html><body style="font-family:system-ui;">
        <h2>Host Login</h2>
        <form method="post" action="/host-login">
          <input type="password" name="key" placeholder="Host Key" style="padding:8px;">
          <button type="submit" style="padding:8px 12px;">OK</button>
        </form>
        </body></html>
    """;
    ctx.Response.ContentType = "text/html; charset=utf-8";
    await ctx.Response.WriteAsync(html);
});

app.MapPost("/host-login", async ctx =>
{
    var cfg = ctx.RequestServices.GetRequiredService<IConfiguration>();
    var key = (await ctx.Request.ReadFormAsync())["key"].ToString();
    if (!string.IsNullOrWhiteSpace(key) && key == cfg["HostKey"])
    {
        ctx.Response.Cookies.Append("gec_host", "ok", new CookieOptions
        {
            HttpOnly = true,
            Secure = false,
            SameSite = SameSiteMode.Lax,
            MaxAge = TimeSpan.FromHours(12)
        });
        ctx.Response.Redirect("/");
    }
    else
    {
        ctx.Response.Redirect("/host-login");
    }
});

// ここがポイント：ホスト画面( / )の直前でクッキーチェック
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Path == "/" && ctx.Request.Cookies["gec_host"] != "ok")
    {
        ctx.Response.Redirect("/host-login");
        return;
    }
    await next();
});
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseRouting();

app.MapRazorPages();
app.MapHub<VoteHub>("/hub/vote");
app.MapControllers();

app.Run();
