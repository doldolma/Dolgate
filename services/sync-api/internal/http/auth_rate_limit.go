package http

import (
	"strings"
	"sync"
	"time"
)

type RateLimitRuleConfig struct {
	Limit         int
	WindowSeconds int
}

type AuthRateLimitConfig struct {
	Login    RateLimitRuleConfig
	Signup   RateLimitRuleConfig
	Refresh  RateLimitRuleConfig
	Exchange RateLimitRuleConfig
}

type authRateLimiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	now     func() time.Time
	entries map[string]authRateLimitEntry
}

type authRateLimitEntry struct {
	count   int
	resetAt time.Time
}

type authRouteLimiters struct {
	login    *authRateLimiter
	signup   *authRateLimiter
	refresh  *authRateLimiter
	exchange *authRateLimiter
}

func newAuthRouteLimiters(config AuthRateLimitConfig) authRouteLimiters {
	return authRouteLimiters{
		login:    newAuthRateLimiter(resolveRateLimitRule(config.Login, 10, 300)),
		signup:   newAuthRateLimiter(resolveRateLimitRule(config.Signup, 5, 900)),
		refresh:  newAuthRateLimiter(resolveRateLimitRule(config.Refresh, 30, 300)),
		exchange: newAuthRateLimiter(resolveRateLimitRule(config.Exchange, 30, 300)),
	}
}

func newAuthRateLimiter(config RateLimitRuleConfig) *authRateLimiter {
	if config.Limit <= 0 || config.WindowSeconds <= 0 {
		return nil
	}
	return &authRateLimiter{
		limit:   config.Limit,
		window:  time.Duration(config.WindowSeconds) * time.Second,
		now:     time.Now,
		entries: make(map[string]authRateLimitEntry),
	}
}

func resolveRateLimitRule(input RateLimitRuleConfig, defaultLimit int, defaultWindowSeconds int) RateLimitRuleConfig {
	rule := input
	if rule.Limit <= 0 {
		rule.Limit = defaultLimit
	}
	if rule.WindowSeconds <= 0 {
		rule.WindowSeconds = defaultWindowSeconds
	}
	return rule
}

func (limiter *authRateLimiter) Allow(keys ...string) bool {
	if limiter == nil {
		return true
	}

	normalizedKeys := uniqueRateLimitKeys(keys)
	if len(normalizedKeys) == 0 {
		return true
	}

	now := limiter.now()

	limiter.mu.Lock()
	defer limiter.mu.Unlock()

	for key, entry := range limiter.entries {
		if !now.Before(entry.resetAt) {
			delete(limiter.entries, key)
		}
	}

	for _, key := range normalizedKeys {
		entry, ok := limiter.entries[key]
		if ok && now.Before(entry.resetAt) && entry.count >= limiter.limit {
			return false
		}
	}

	for _, key := range normalizedKeys {
		entry, ok := limiter.entries[key]
		if !ok || !now.Before(entry.resetAt) {
			limiter.entries[key] = authRateLimitEntry{
				count:   1,
				resetAt: now.Add(limiter.window),
			}
			continue
		}
		entry.count += 1
		limiter.entries[key] = entry
	}

	return true
}

func uniqueRateLimitKeys(keys []string) []string {
	seen := make(map[string]struct{}, len(keys))
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		trimmed := strings.TrimSpace(key)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}

func authAttemptKeys(clientIP string, email string) []string {
	keys := make([]string, 0, 2)
	normalizedIP := strings.TrimSpace(clientIP)
	if normalizedIP != "" {
		keys = append(keys, "ip:"+normalizedIP)
	}
	normalizedEmail := strings.ToLower(strings.TrimSpace(email))
	if normalizedEmail != "" {
		keys = append(keys, "email:"+normalizedEmail)
	}
	return keys
}
