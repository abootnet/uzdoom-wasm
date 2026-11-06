<?php

namespace App\Http\Controllers;

use App\Models\Lobby;
use App\Models\LobbyPlayer;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rule;

class LobbyController extends Controller
{
    private const STALE_SECONDS = 45;

    /** Drop players who stopped heartbeating; close empty lobbies. */
    private function prune(): void
    {
        $cut = now()->subSeconds(self::STALE_SECONDS);
        LobbyPlayer::where('last_seen_at', '<', $cut)->get()->each(fn ($p) => $this->removePlayer($p));
        Lobby::where('status', '!=', 'closed')->whereDoesntHave('players')->update(['status' => 'closed']);
    }

    private function removePlayer(LobbyPlayer $p): void
    {
        $lobby = $p->lobby;
        $wasHost = $lobby->host_id === $p->user_id;
        $p->delete();
        if ($lobby->status === 'closed') return;
        $next = $lobby->players()->first();
        if (!$next) { $lobby->update(['status' => 'closed']); return; }
        if ($wasHost) $lobby->update(['host_id' => $next->user_id]);
    }

    public function index(): JsonResponse
    {
        $this->prune();
        $lobbies = Lobby::with('host')->whereIn('status', ['open', 'playing'])->latest('updated_at')->limit(100)->get();
        return response()->json(['lobbies' => $lobbies->map(fn ($l) => $l->toPublic(false))->values()]);
    }

    public function store(Request $r): JsonResponse
    {
        $d = $r->validate([
            'name' => ['required', 'string', 'min:2', 'max:60'],
            'mode' => ['required', Rule::in(['coop', 'deathmatch'])],
            'iwad' => ['required', 'string', 'regex:/^[A-Za-z0-9_.\-]{1,60}$/'],
            'mods' => ['nullable', 'array', 'max:10'],
            'mods.*.id' => ['required', 'integer'],
            'mods.*.title' => ['required', 'string', 'max:120'],
            'map' => ['nullable', 'string', 'regex:/^[A-Za-z0-9_]{2,8}$/'],
            'skill' => ['nullable', 'integer', 'between:1,5'],
            'max_players' => ['nullable', 'integer', 'between:2,8'],
            'password' => ['nullable', 'string', 'max:64'],
        ]);
        $user = $r->user();
        // One active lobby per user.
        $this->prune();
        if (LobbyPlayer::where('user_id', $user->id)->exists()) {
            return response()->json(['message' => 'Leave your current lobby first.'], 409);
        }
        $lobby = DB::transaction(function () use ($d, $user) {
            $l = Lobby::create([
                'host_id' => $user->id, 'name' => $d['name'], 'mode' => $d['mode'],
                'iwad' => $d['iwad'], 'mods' => $d['mods'] ?? [], 'map' => $d['map'] ?? null,
                'skill' => $d['skill'] ?? 3, 'max_players' => $d['max_players'] ?? 4,
                'password_hash' => !empty($d['password']) ? Hash::make($d['password']) : null,
            ]);
            LobbyPlayer::create(['lobby_id' => $l->id, 'user_id' => $user->id, 'slot' => 0, 'last_seen_at' => now()]);
            return $l;
        });
        return response()->json(['lobby' => $lobby->load('host', 'players.user')->toPublic()], 201);
    }

    public function show(Request $r, Lobby $lobby): JsonResponse
    {
        $me = LobbyPlayer::where('lobby_id', $lobby->id)->where('user_id', $r->user()->id)->first();
        $me?->update(['last_seen_at' => now()]);   // heartbeat
        $this->prune();
        $lobby->refresh()->load('host', 'players.user');
        return response()->json(['lobby' => $lobby->toPublic(), 'you' => $me?->slot, 'is_host' => $lobby->host_id === $r->user()->id]);
    }

    public function join(Request $r, Lobby $lobby): JsonResponse
    {
        $user = $r->user();
        return DB::transaction(function () use ($r, $lobby, $user) {
            $lobby = Lobby::lockForUpdate()->find($lobby->id);
            if ($lobby->status !== 'open') return response()->json(['message' => 'Lobby is not open.'], 409);
            if ($lobby->password_hash && !Hash::check((string)$r->input('password', ''), $lobby->password_hash)) {
                return response()->json(['message' => 'Wrong password.'], 403);
            }
            $existing = LobbyPlayer::where('lobby_id', $lobby->id)->where('user_id', $user->id)->first();
            if ($existing) return response()->json(['slot' => $existing->slot]);
            if (LobbyPlayer::where('user_id', $user->id)->exists()) {
                return response()->json(['message' => 'Leave your current lobby first.'], 409);
            }
            $taken = $lobby->players()->pluck('slot')->all();
            $slot = collect(range(0, $lobby->max_players - 1))->first(fn ($s) => !in_array($s, $taken, true));
            if ($slot === null) return response()->json(['message' => 'Lobby is full.'], 409);
            LobbyPlayer::create(['lobby_id' => $lobby->id, 'user_id' => $user->id, 'slot' => $slot, 'last_seen_at' => now()]);
            return response()->json(['slot' => $slot], 201);
        });
    }

    public function leave(Request $r, Lobby $lobby): JsonResponse
    {
        $p = LobbyPlayer::where('lobby_id', $lobby->id)->where('user_id', $r->user()->id)->first();
        if ($p) $this->removePlayer($p);
        return response()->json(['ok' => true]);
    }

    public function ready(Request $r, Lobby $lobby): JsonResponse
    {
        $d = $r->validate(['ready' => ['required', 'boolean']]);
        LobbyPlayer::where('lobby_id', $lobby->id)->where('user_id', $r->user()->id)->update(['ready' => $d['ready']]);
        return response()->json(['ok' => true]);
    }

    public function start(Request $r, Lobby $lobby): JsonResponse
    {
        if ($lobby->host_id !== $r->user()->id) return response()->json(['message' => 'Only the host can start.'], 403);
        if ($lobby->status !== 'open') return response()->json(['message' => 'Already started.'], 409);
        $notReady = $lobby->players()->where('user_id', '!=', $lobby->host_id)->where('ready', false)->count();
        if ($notReady) return response()->json(['message' => 'Not everyone is ready.'], 409);
        $lobby->update(['status' => 'playing', 'started_at' => now()]);
        return response()->json(['ok' => true]);
    }

    /** Short-lived signed ticket the relay verifies; binds user to lobby+slot. */
    public function ticket(Request $r, Lobby $lobby): JsonResponse
    {
        $p = LobbyPlayer::where('lobby_id', $lobby->id)->where('user_id', $r->user()->id)->first();
        if (!$p) return response()->json(['message' => 'Not in this lobby.'], 403);
        if ($lobby->status !== 'playing') return response()->json(['message' => 'Game has not started.'], 409);
        $payload = rtrim(strtr(base64_encode(json_encode([
            'lobby' => $lobby->id, 'slot' => $p->slot, 'uid' => $p->user_id,
            'host' => $lobby->host_id === $p->user_id, 'max' => $lobby->max_players,
            'exp' => time() + 120,
        ])), '+/', '-_'), '=');
        $sig = rtrim(strtr(base64_encode(hash_hmac('sha256', $payload, env('RELAY_SECRET'), true)), '+/', '-_'), '=');
        return response()->json(['ticket' => "$payload.$sig", 'relay' => env('RELAY_URL')]);
    }
}
