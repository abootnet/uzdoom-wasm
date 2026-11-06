<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('player_stats', function (Blueprint $t) {
            $t->id();
            $t->foreignId('user_id')->unique()->constrained()->cascadeOnDelete();
            $t->unsignedBigInteger('seconds_played')->default(0);
            $t->unsignedBigInteger('monsters_killed')->default(0);
            $t->unsignedBigInteger('deaths')->default(0);
            $t->unsignedBigInteger('frags')->default(0);          // other players killed
            $t->unsignedBigInteger('items_collected')->default(0);
            $t->unsignedBigInteger('secrets_found')->default(0);
            $t->unsignedBigInteger('levels_completed')->default(0);
            $t->unsignedBigInteger('games_played')->default(0);
            $t->timestamps();
            $t->index('monsters_killed');
            $t->index('seconds_played');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('player_stats');
    }
};
