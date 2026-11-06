<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('lobby_players', function (Blueprint $t) {
            $t->id();
            $t->foreignId('lobby_id')->constrained()->cascadeOnDelete();
            $t->foreignId('user_id')->constrained()->cascadeOnDelete();
            $t->unsignedTinyInteger('slot');        // 0 = host
            $t->boolean('ready')->default(false);
            $t->timestamp("last_seen_at")->nullable();
            $t->timestamps();
            $t->unique(['lobby_id', 'user_id']);
            $t->unique(['lobby_id', 'slot']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('lobby_players');
    }
};
