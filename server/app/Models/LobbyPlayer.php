<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class LobbyPlayer extends Model
{
    protected $fillable = ['lobby_id', 'user_id', 'slot', 'ready', 'last_seen_at'];
    protected $casts = ['ready' => 'boolean', 'last_seen_at' => 'datetime'];

    public function lobby(): BelongsTo { return $this->belongsTo(Lobby::class); }
    public function user(): BelongsTo { return $this->belongsTo(User::class); }
}
