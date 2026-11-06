<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class PlayerStat extends Model
{
    /** Counter columns a client may add to, with the max accepted per request. */
    public const COUNTERS = [
        'seconds_played'   => 7200,
        'monsters_killed'  => 5000,
        'deaths'           => 1000,
        'frags'            => 1000,
        'items_collected'  => 5000,
        'secrets_found'    => 1000,
        'levels_completed' => 200,
        'games_played'     => 20,
    ];

    protected $fillable = ['user_id', 'seconds_played', 'monsters_killed', 'deaths', 'frags',
                           'items_collected', 'secrets_found', 'levels_completed', 'games_played'];

    public function user(): BelongsTo { return $this->belongsTo(User::class); }
}
