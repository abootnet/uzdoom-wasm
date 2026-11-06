<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('lobbies', function (Blueprint $t) {
            $t->id();
            $t->foreignId('host_id')->constrained('users')->cascadeOnDelete();
            $t->string('name', 60);
            $t->string('mode', 12);                 // coop | deathmatch
            $t->string('iwad', 60);                 // e.g. doom2.wad, freedoom2.wad
            $t->json('mods')->nullable();           // [{id, title}] idgames entries
            $t->string('map', 16)->nullable();
            $t->unsignedTinyInteger('skill')->default(3);
            $t->unsignedTinyInteger('max_players')->default(4);
            $t->string('password_hash')->nullable();
            $t->string('status', 10)->default('open'); // open | playing | closed
            $t->timestamp('started_at')->nullable();
            $t->timestamps();
            $t->index(['status', 'updated_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('lobbies');
    }
};
