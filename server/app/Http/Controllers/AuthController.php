<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rules\Password;

class AuthController extends Controller
{
    public function me(Request $r): JsonResponse
    {
        $u = $r->user();
        return response()->json([
            'user' => $u ? ['id' => $u->id, 'name' => $u->name] : null,
            'csrf' => csrf_token(),
        ]);
    }

    public function register(Request $r): JsonResponse
    {
        $d = $r->validate([
            'name' => ['required', 'string', 'min:3', 'max:24', 'regex:/^[A-Za-z0-9_\-]+$/', 'unique:users,name'],
            'email' => ['required', 'email', 'max:255', 'unique:users,email'],
            'password' => ['required', Password::min(8)],
        ]);
        $u = User::create([
            'name' => $d['name'], 'email' => $d['email'],
            'password' => Hash::make($d['password']),
        ]);
        Auth::login($u);
        $r->session()->regenerate();
        return response()->json(['user' => ['id' => $u->id, 'name' => $u->name], 'csrf' => csrf_token()], 201);
    }

    public function login(Request $r): JsonResponse
    {
        $d = $r->validate(['login' => ['required', 'string'], 'password' => ['required', 'string']]);
        $field = filter_var($d['login'], FILTER_VALIDATE_EMAIL) ? 'email' : 'name';
        if (!Auth::attempt([$field => $d['login'], 'password' => $d['password']])) {
            return response()->json(['message' => 'Invalid credentials.'], 422);
        }
        $r->session()->regenerate();
        $u = $r->user();
        return response()->json(['user' => ['id' => $u->id, 'name' => $u->name], 'csrf' => csrf_token()]);
    }

    public function logout(Request $r): JsonResponse
    {
        Auth::logout();
        $r->session()->invalidate();
        $r->session()->regenerateToken();
        return response()->json(['ok' => true, 'csrf' => csrf_token()]);
    }
}
