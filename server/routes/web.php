<?php

use App\Http\Controllers\AuthController;
use App\Http\Controllers\LobbyController;
use App\Http\Controllers\StatsController;
use Illuminate\Support\Facades\Route;

Route::redirect('/', '/play/index.html');

// JSON API, session-cookie auth. These routes live in the `web` group so
// CSRF protection applies; the launcher sends X-CSRF-TOKEN from /api/me.
Route::prefix('api')->group(function () {
    Route::get('me', [AuthController::class, 'me']);
    Route::post('register', [AuthController::class, 'register'])->middleware('throttle:10,1');
    Route::post('login', [AuthController::class, 'login'])->middleware('throttle:10,1');
    Route::post('logout', [AuthController::class, 'logout']);

    Route::get('leaderboard', [StatsController::class, 'leaderboard']);

    Route::middleware('auth')->group(function () {
        Route::get('stats', [StatsController::class, 'me']);
        Route::post('stats', [StatsController::class, 'store'])->middleware('throttle:30,1');
        Route::get('lobbies', [LobbyController::class, 'index']);
        Route::post('lobbies', [LobbyController::class, 'store'])->middleware('throttle:20,1');
        Route::get('lobbies/{lobby}', [LobbyController::class, 'show']);
        Route::post('lobbies/{lobby}/join', [LobbyController::class, 'join']);
        Route::post('lobbies/{lobby}/leave', [LobbyController::class, 'leave']);
        Route::post('lobbies/{lobby}/ready', [LobbyController::class, 'ready']);
        Route::post('lobbies/{lobby}/start', [LobbyController::class, 'start']);
        Route::post('lobbies/{lobby}/ticket', [LobbyController::class, 'ticket']);
    });
});
