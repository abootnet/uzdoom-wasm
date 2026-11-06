<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Lobby extends Model
{
    protected $fillable = ['host_id', 'name', 'mode', 'iwad', 'mods', 'map', 'skill',
                           'max_players', 'password_hash', 'status', 'started_at'];
    protected $hidden = ['password_hash'];
    protected $attributes = ['status' => 'open'];
    protected $casts = ['mods' => 'array', 'started_at' => 'datetime'];

    public function host(): BelongsTo { return $this->belongsTo(User::class, 'host_id'); }
    public function players(): HasMany { return $this->hasMany(LobbyPlayer::class)->orderBy('slot'); }

    public function toPublic(bool $withPlayers = true): array
    {
        $a = [
            'id' => $this->id, 'name' => $this->name, 'mode' => $this->mode,
            'iwad' => $this->iwad, 'mods' => $this->mods ?? [], 'map' => $this->map,
            'skill' => $this->skill, 'max_players' => $this->max_players,
            'locked' => $this->password_hash !== null, 'status' => $this->status,
            'host' => $this->host?->name,
        ];
        if ($withPlayers) {
            $a['players'] = $this->players->map(fn ($p) => [
                'slot' => $p->slot, 'name' => $p->user->name, 'ready' => $p->ready,
                'host' => $p->user_id === $this->host_id,
            ])->values();
        } else {
            $a['player_count'] = $this->players()->count();
        }
        return $a;
    }
}
