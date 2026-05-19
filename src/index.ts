export interface Env {
  ROOMS: DurableObjectNamespace;
}

type JoinRequest = { clientId: string; displayName?: string; password: string };
type SignalEnvelope = { type: "signal"; from: string; payload: unknown };
type PresenceEnvelope = { type: "presence"; members: Array<{ id: string; displayName: string }> };

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

    if (request.method === "GET" && url.pathname === "/") return htmlResponse(homeHtml());
    if (request.method === "GET" && url.pathname.startsWith("/room/")) {
      return htmlResponse(roomHtml(url.pathname.split("/")[2] || ""));
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
  private sockets = new Map<string, WebSocket>();

  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/init") {
      const old = await this.getState();
      if (old.password) return json({ ok: true });
      const { password } = (await request.json()) as { password: string };
      await this.state.storage.put("state", { password, members: {} } satisfies RoomState);
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname.endsWith("/status")) {
      const state = await this.getState();
      return json({ activeMembers: this.activeCount(state), exists: !!state.password });
    }

    if (request.method === "POST" && url.pathname.endsWith("/join")) {
      const body = (await request.json()) as JoinRequest;
      const state = await this.getState();
      if (!state.password) return json({ error: "room expired" }, 410);
      if (body.password !== state.password) return json({ error: "wrong password" }, 401);
      this.cleanupStale(state);
      if (!state.members[body.clientId] && this.activeCount(state) >= MAX_MEMBERS) return json({ error: "room full" }, 409);
      state.members[body.clientId] = { displayName: body.displayName?.trim() || "Guest", lastSeenAt: Date.now() };
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
      await this.leaveClient(clientId);
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname.endsWith("/ws")) {
      const clientId = url.searchParams.get("clientId") ?? "";
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sockets.set(clientId, server);

      server.addEventListener("message", (event) => {
        this.onSignal(clientId, String(event.data));
      });
      server.addEventListener("close", () => this.leaveClient(clientId));
      void this.broadcastPresence();

      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: "not found" }, 404);
  }

  async alarm(): Promise<void> {
    const state = await this.getState();
    this.cleanupStale(state);
    if (this.activeCount(state) === 0) await this.state.storage.deleteAll();
    else await this.state.storage.put("state", state);
  }

  private async onSignal(from: string, text: string): Promise<void> {
    let parsed: { to?: string; payload?: unknown } = {};
    try { parsed = JSON.parse(text) as { to?: string; payload?: unknown }; } catch { return; }
    if (!parsed.to || !this.sockets.get(parsed.to)) return;
    const msg: SignalEnvelope = { type: "signal", from, payload: parsed.payload };
    this.sockets.get(parsed.to)?.send(JSON.stringify(msg));
  }

  private async leaveClient(clientId: string): Promise<void> {
    this.sockets.delete(clientId);
    const state = await this.getState();
    delete state.members[clientId];
    await this.state.storage.put("state", state);
    if (this.activeCount(state) === 0) await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    await this.broadcastPresence();
  }

  private async broadcastPresence(): Promise<void> {
    const state = await this.getState();
    const members = [...this.sockets.keys()].map((id) => ({
      id,
      displayName: state.members[id]?.displayName || "Guest",
    }));
    const payload: PresenceEnvelope = { type: "presence", members };
    for (const socket of this.sockets.values()) socket.send(JSON.stringify(payload));
  }

  private async getState(): Promise<RoomState> {
    return (await this.state.storage.get<RoomState>("state")) ?? { password: "", members: {} };
  }
  private cleanupStale(state: RoomState): void {
    const now = Date.now();
    for (const [id, member] of Object.entries(state.members)) if (now - member.lastSeenAt > HEARTBEAT_STALE_MS) delete state.members[id];
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

function homeHtml(): string { return `<!doctype html><html lang="ja"><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>開始</title><body>
<h1>ビデオチャット開始</h1><input id="name" placeholder="名前(任意)"/><button id="create">ルーム作成</button><button id="copyPassword" disabled>パスワードをコピー</button><pre id="out"></pre>
<script>
create.onclick=async()=>{const r=await fetch('/api/rooms',{method:'POST'});const d=await r.json();const n=name.value?('?name='+encodeURIComponent(name.value)):'';const u=d.joinUrl+n;out.textContent='参加URL: '+u+'\\nパスワード: '+d.password;};
</script></body></html>`; }

function roomHtml(roomId: string): string { return `<!doctype html><html lang="ja"><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>参加</title>
<style>video{width:46vw;max-width:320px;aspect-ratio:1/1;object-fit:cover;background:#000}.mir{transform:scaleX(-1)}</style><body>
<h2>ルーム ${roomId}</h2><input id="name" placeholder="名前(任意)"/><input id="password" placeholder="パスワード"/>
<div><button id="copy">URLコピー</button><button id="join">参加</button><button id="mute">ミュートON/OFF</button><button id="cam">カメラON/OFF</button><button id="switchCam">カメラ切替</button><button id="mirror">ミラーON/OFF</button><button id="leave">退室</button></div>
<div><div>あなた: <span id="localName">-</span></div><div>相手: <span id="remoteName">-</span></div></div><video id="local" autoplay playsinline muted></video><video id="remote" autoplay playsinline></video><pre id="msg"></pre>
<script>
const roomId='${roomId}', clientId=localStorage.getItem('clientId')||crypto.randomUUID(); localStorage.setItem('clientId',clientId);
const qs=new URLSearchParams(location.search); if(qs.get('name')) name.value=qs.get('name');
let localStream, pc, ws, hb, facing='user', mirrorOn=true, camIndex=0, devices=[], members=[];
const cfg={iceServers:[{urls:['stun:stun.l.google.com:19302']}]};
copy.onclick=()=>navigator.clipboard.writeText(location.href);
async function getStream(){devices=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
 const c = devices[camIndex]?.deviceId ? {deviceId:{exact:devices[camIndex].deviceId}} : {facingMode:{ideal:facing}};
 localStream = await navigator.mediaDevices.getUserMedia({video:c,audio:true}); local.srcObject=localStream; applyMirror();}
function applyMirror(){local.classList.toggle('mir',mirrorOn)}
async function setupPc(){pc=new RTCPeerConnection(cfg); localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
 pc.ontrack=e=>remote.srcObject=e.streams[0]; pc.onicecandidate=e=>e.candidate&&ws.send(JSON.stringify({to:otherId(),payload:{candidate:e.candidate}}));}
function myName(){return (name.value||'').trim()||'Guest'}
function syncNames(){const me=members.find(m=>m.id===clientId);const peer=members.find(m=>m.id!==clientId);localName.textContent=(me&&me.displayName)||myName();remoteName.textContent=(peer&&peer.displayName)||'-';}
function otherId(){const p=members.find(m=>m.id!==clientId);return p&&p.id}
join.onclick=async()=>{await getStream(); const jr=await fetch('/api/rooms/'+roomId+'/join',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId,password:password.value,displayName:name.value})});
 const jd=await jr.json(); if(!jr.ok){msg.textContent='参加失敗: '+(jd.error||jr.status);return;} hb=setInterval(()=>fetch('/api/rooms/'+roomId+'/heartbeat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId})}),20000);
 ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/api/rooms/'+roomId+'/ws?clientId='+encodeURIComponent(clientId)); ws.onmessage=async(ev)=>{const m=JSON.parse(ev.data);
 if(m.type==='presence'){members=m.members||[];syncNames(); if(members.length===2&&!pc){await setupPc(); const oid=otherId(); if(oid&&clientId<oid){const offer=await pc.createOffer(); await pc.setLocalDescription(offer); ws.send(JSON.stringify({to:oid,payload:{sdp:offer}}));}}
 return;} if(m.type==='signal'){if(!pc) await setupPc(); const p=m.payload; if(p.sdp){await pc.setRemoteDescription(new RTCSessionDescription(p.sdp)); if(p.sdp.type==='offer'){const ans=await pc.createAnswer(); await pc.setLocalDescription(ans); ws.send(JSON.stringify({to:m.from,payload:{sdp:ans}}));}} if(p.candidate) await pc.addIceCandidate(new RTCIceCandidate(p.candidate));}};
 msg.textContent='参加成功';};
mute.onclick=()=>localStream&&localStream.getAudioTracks().forEach(t=>t.enabled=!t.enabled);
cam.onclick=()=>localStream&&localStream.getVideoTracks().forEach(t=>t.enabled=!t.enabled);
switchCam.onclick=async()=>{if(!devices.length)return;camIndex=(camIndex+1)%devices.length;const old=localStream;await getStream();if(pc){const s=pc.getSenders().find(x=>x.track&&x.track.kind==='video');if(s)await s.replaceTrack(localStream.getVideoTracks()[0]);}old&&old.getTracks().forEach(t=>t.stop());facing=(facing==='user'?'environment':'user');if(facing==='user'&&mirrorOn===false){mirrorOn=true;applyMirror();}if(facing!=='user'&&mirrorOn===true){mirrorOn=false;applyMirror();}};
mirror.onclick=()=>{mirrorOn=!mirrorOn;applyMirror();if(pc){const track=localStream.getVideoTracks()[0];const p=pc.getSenders().find(s=>s.track&&s.track.kind==='video'); p&&p.replaceTrack(track);}};
leave.onclick=async()=>{clearInterval(hb);ws&&ws.close();pc&&pc.close();localStream&&localStream.getTracks().forEach(t=>t.stop());await fetch('/api/rooms/'+roomId+'/leave',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId})});msg.textContent='退室';};
addEventListener('beforeunload',()=>navigator.sendBeacon('/api/rooms/'+roomId+'/leave',new Blob([JSON.stringify({clientId})],{type:'application/json'})));
</script></body></html>`; }
