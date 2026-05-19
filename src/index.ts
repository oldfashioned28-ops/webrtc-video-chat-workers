export interface Env {
  ROOMS: DurableObjectNamespace;
}

type JoinRequest = { clientId: string; displayName?: string; password: string };

type RoomState = {
  password: string;
  members: Record<string, { displayName: string; lastSeenAt: number }>;
};

const ROOM_TTL_MS = 60_000;
const HEARTBEAT_STALE_MS = 45_000;
const MAX_MEMBERS = 2;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return htmlResponse(homeHtml());
    }
    if (request.method === "GET" && url.pathname.startsWith("/room/")) {
      const roomId = url.pathname.split("/")[2] || "";
      return htmlResponse(roomHtml(roomId));
    }
    if (request.method === "POST" && url.pathname === "/api/rooms") {
      const roomId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const password = randomPassword();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      await stub.fetch("https://room/init", { method: "POST", body: JSON.stringify({ password }) });
      return json({ roomId, password, joinUrl: `${url.origin}/room/${roomId}` });
    }
    if (url.pathname.startsWith("/api/rooms/")) {
      const roomId = url.pathname.split("/")[3];
      if (!roomId) return json({ error: "invalid room" }, 400);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      return stub.fetch(new Request(`https://room${url.pathname}${url.search}`, request));
    }

    return new Response("Not Found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;

export class Room implements DurableObject {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/init") {
      const state = await this.getState();
      if (state.password) return json({ ok: true });
      const { password } = (await request.json()) as { password: string };
      await this.state.storage.put("state", { password, members: {} } satisfies RoomState);
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname.endsWith("/status")) {
      const state = await this.getState();
      const count = this.activeCount(state);
      return json({ activeMembers: count, exists: !!state.password });
    }

    if (request.method === "POST" && url.pathname.endsWith("/join")) {
      const body = (await request.json()) as JoinRequest;
      const state = await this.getState();
      if (!state.password) return json({ error: "room expired" }, 410);
      if (body.password !== state.password) return json({ error: "wrong password" }, 401);

      this.cleanupStale(state);
      if (!state.members[body.clientId] && this.activeCount(state) >= MAX_MEMBERS) {
        return json({ error: "room full" }, 409);
      }
      state.members[body.clientId] = {
        displayName: body.displayName?.trim() || "Guest",
        lastSeenAt: Date.now(),
      };
      await this.state.storage.put("state", state);
      await this.state.storage.deleteAlarm();
      return json({ ok: true, activeMembers: this.activeCount(state) });
    }

    if (request.method === "POST" && url.pathname.endsWith("/heartbeat")) {
      const { clientId } = (await request.json()) as { clientId: string };
      const state = await this.getState();
      if (state.members[clientId]) {
        state.members[clientId].lastSeenAt = Date.now();
        await this.state.storage.put("state", state);
      }
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname.endsWith("/leave")) {
      const { clientId } = (await request.json()) as { clientId: string };
      const state = await this.getState();
      delete state.members[clientId];
      await this.state.storage.put("state", state);
      if (this.activeCount(state) === 0) {
        await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      }
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  }

  async alarm(): Promise<void> {
    const state = await this.getState();
    this.cleanupStale(state);
    if (this.activeCount(state) === 0) {
      await this.state.storage.deleteAll();
      return;
    }
    await this.state.storage.put("state", state);
  }

  private async getState(): Promise<RoomState> {
    return (await this.state.storage.get<RoomState>("state")) ?? { password: "", members: {} };
  }

  private cleanupStale(state: RoomState): void {
    const now = Date.now();
    for (const [id, member] of Object.entries(state.members)) {
      if (now - member.lastSeenAt > HEARTBEAT_STALE_MS) delete state.members[id];
    }
  }

  private activeCount(state: RoomState): number {
    this.cleanupStale(state);
    return Object.keys(state.members).length;
  }
}

function randomPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
function htmlResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function homeHtml(): string { return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1" /><title>開始ページ</title>
<body><h1>ビデオチャット開始</h1><label>名前(任意) <input id="name" /></label><button id="create">ルーム作成</button><pre id="out"></pre>
<script>
document.getElementById('create').onclick = async () => {
 const r = await fetch('/api/rooms',{method:'POST'}); const d = await r.json();
 const name = document.getElementById('name').value || '';
 const join = d.joinUrl + (name ? ('?name='+encodeURIComponent(name)) : '');
 document.getElementById('out').textContent = `参加URL: ${join}\nパスワード: ${d.password}`;
};
</script></body></html>`; }

function roomHtml(roomId: string): string { return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1" /><title>参加</title>
<body><h1>ルーム参加</h1><p>Room: ${roomId}</p>
<label>名前(任意) <input id="name" /></label><label>パスワード <input id="password" /></label>
<button id="copy">URLコピー</button><button id="join">参加</button><button id="leave">退室</button><pre id="msg"></pre>
<script>
const roomId='${roomId}'; const clientId = localStorage.getItem('clientId') || crypto.randomUUID(); localStorage.setItem('clientId', clientId);
const qs = new URLSearchParams(location.search); if(qs.get('name')) document.getElementById('name').value=qs.get('name');
let timer=null;
copy.onclick=()=>navigator.clipboard.writeText(location.href);
join.onclick=async()=>{ const body={clientId,password:password.value,displayName:name.value};
 const r=await fetch('/api/rooms/'+roomId+'/join',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const d=await r.json(); msg.textContent=r.ok?'参加成功':('失敗: '+(d.error||r.status));
 if(r.ok){timer=setInterval(()=>fetch('/api/rooms/'+roomId+'/heartbeat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId})}),20000);} };
leave.onclick=async()=>{await fetch('/api/rooms/'+roomId+'/leave',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId})});msg.textContent='退室しました';if(timer)clearInterval(timer);};
addEventListener('beforeunload',()=>navigator.sendBeacon('/api/rooms/'+roomId+'/leave',new Blob([JSON.stringify({clientId})],{type:'application/json'})));
</script></body></html>`; }
