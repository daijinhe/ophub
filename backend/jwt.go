package main

import (
	"context"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims JWT 载荷
type Claims struct {
	UserID   uint   `json:"uid"`
	Username string `json:"username"`
	jwt.RegisteredClaims
}

// GenerateToken 生成 JWT
func GenerateToken(userID uint, username string) (string, error) {
	exp := time.Now().Add(time.Duration(Cfg.JWTTTL) * time.Minute)
	claims := Claims{
		UserID:   userID,
		Username: username,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(exp),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(Cfg.JWTSecret))
}

// ParseToken 解析 JWT
func ParseToken(t string) (*Claims, error) {
	claims := &Claims{}
	_, err := jwt.ParseWithClaims(t, claims, func(tk *jwt.Token) (interface{}, error) {
		return []byte(Cfg.JWTSecret), nil
	})
	if err != nil {
		return nil, err
	}
	return claims, nil
}

// LogoutToken 将令牌加入黑名单（按剩余有效期）
func LogoutToken(token string) error {
	claims, err := ParseToken(token)
	if err != nil {
		return nil
	}
	ttl := time.Until(claims.ExpiresAt.Time)
	if ttl <= 0 {
		return nil
	}
	return RDB.Set(context.Background(), "bl:"+token, "1", ttl).Err()
}

// IsBlacklisted 检查令牌是否在黑名单
func IsBlacklisted(token string) bool {
	ok, err := RDB.Exists(context.Background(), "bl:"+token).Result()
	if err != nil {
		return false
	}
	return ok > 0
}
