<?php

namespace App\Http\Controllers;

use App\Models\PlayerStat;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class StatsController extends Controller
{
    private const LEADERBOARD_BY = ['monsters_killed', 'seconds_played', 'levels_completed', 'frags'];

    private function totals(int $userId): array
    {
        $row = PlayerStat::where('user_id', $userId)->first();
        return collect(array_keys(PlayerStat::COUNTERS))
            ->mapWithKeys(fn ($k) => [$k => (int)($row->$k ?? 0)])->all();
    }

    public function me(Request $r): JsonResponse
    {
        return response()->json(['stats' => $this->totals($r->user()->id)]);
    }

    /**
     * Add deltas to the signed-in player's lifetime totals.
     * Stats are reported by the browser, so they are casual/unauthenticated by
     * nature: each field is clamped per request and the route is throttled.
     */
    public function store(Request $r): JsonResponse
    {
        $add = [];
        foreach (PlayerStat::COUNTERS as $col => $max) {
            $v = $r->input($col, 0);
            if (!is_numeric($v)) continue;
            $v = (int) max(0, min((float) $v, $max));
            if ($v > 0) $add[$col] = $v;
        }
        if ($add) {
            DB::transaction(function () use ($r, $add) {
                $row = PlayerStat::firstOrCreate(['user_id' => $r->user()->id]);
                $row = PlayerStat::lockForUpdate()->find($row->id);
                foreach ($add as $col => $v) $row->$col += $v;
                $row->save();
            });
        }
        return response()->json(['stats' => $this->totals($r->user()->id)]);
    }

    public function leaderboard(Request $r): JsonResponse
    {
        $by = in_array($r->query('by'), self::LEADERBOARD_BY, true) ? $r->query('by') : 'monsters_killed';
        $rows = PlayerStat::with('user:id,name')->where($by, '>', 0)
            ->orderByDesc($by)->limit(10)->get()
            ->map(fn ($s) => ['name' => $s->user->name, 'value' => (int)$s->$by])->values();
        return response()->json(['by' => $by, 'rows' => $rows]);
    }
}
