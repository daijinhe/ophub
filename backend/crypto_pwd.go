package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"log"
)

// 用户密码「可查看」能力所需的可逆加密工具。
//
// 背景：登录校验用 bcrypt 哈希（不可逆），因此无法「查看密码」。
// 为满足管理员查看 / 用户自查密码的诉求，额外以 AES-256-GCM 加密保存一份明文密文。
// 该密文不参与登录校验，与资产表里保存 SSH 明文密码的口径一致。
//
// 密钥来源：PWD_ENC_KEY（任意长度，经 SHA-256 派生为 32 字节）。
// 未配置时回退到内置默认值，保证开箱即用；生产环境建议显式配置并妥善保管。

// defaultPwdEncKey 内置默认密钥（仅当未配置 PWD_ENC_KEY 时使用）
const defaultPwdEncKey = "ophub-default-pwd-enc-key-please-change"

// pwdAEAD 全局 AEAD（GCM）
var pwdAEAD cipher.AEAD

// initPwdCipher 依据配置初始化密码加密器（服务启动时调用一次）
func initPwdCipher() {
	key := Cfg.PwdEncKey
	if key == "" {
		key = defaultPwdEncKey
		log.Println("[警告] 未配置 PWD_ENC_KEY，用户密码将使用内置默认密钥加密，建议在部署时通过环境变量设置")
	}
	sum := sha256.Sum256([]byte(key))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		log.Fatalf("初始化密码加密失败: %v", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		log.Fatalf("初始化密码加密失败: %v", err)
	}
	pwdAEAD = aead
}

// encryptPassword 明文 -> base64(nonce || ciphertext)；空串原样返回空串
func encryptPassword(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	if pwdAEAD == nil {
		initPwdCipher()
	}
	nonce := make([]byte, pwdAEAD.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ct := pwdAEAD.Seal(nil, nonce, []byte(plain), nil)
	return base64.StdEncoding.EncodeToString(append(nonce, ct...)), nil
}

// decryptPassword base64(nonce || ciphertext) -> 明文；空串原样返回空串
func decryptPassword(enc string) (string, error) {
	if enc == "" {
		return "", nil
	}
	if pwdAEAD == nil {
		initPwdCipher()
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", err
	}
	if len(raw) < pwdAEAD.NonceSize() {
		return "", errors.New("密文长度不足")
	}
	nonce, ct := raw[:pwdAEAD.NonceSize()], raw[pwdAEAD.NonceSize():]
	pt, err := pwdAEAD.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}
