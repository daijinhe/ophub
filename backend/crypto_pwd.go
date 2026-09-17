package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
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

// fieldCipherPrefix 是「已加密字段」的识别前缀，避免运行时把明文当密文解析（或反之）。
// 资产 Fields JSONB 里的「普通用户密码 / 超级管理员用户密码 / 密码」逐个 key 加密，
// 落库前用加密函数 = 前缀 + encryptPassword(plain)，读出来时剥前缀后解密。
const fieldCipherPrefix = "enc:v1:"

// encryptField 给单个字段值加密；空串返回空串；非密文前缀的原文也会被加密（幂等 = 「明 → enc」）。
func encryptField(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	// 已经是加密前缀 → 不重复加密
	if strings.HasPrefix(plain, fieldCipherPrefix) {
		return plain, nil
	}
	ct, err := encryptPassword(plain)
	if err != nil {
		return "", err
	}
	return fieldCipherPrefix + ct, nil
}

// decryptField 单个字段值解密；空串返回空串；非密文前缀视为明文直接返回（v1.7.x 平滑迁移用）。
func decryptField(stored string) (string, error) {
	if stored == "" {
		return "", nil
	}
	if !strings.HasPrefix(stored, fieldCipherPrefix) {
		// 旧数据：明文直返。下次落库时会被 encryptField 包成密文。
		return stored, nil
	}
	ct := strings.TrimPrefix(stored, fieldCipherPrefix)
	return decryptPassword(ct)
}

// secretFieldKeys 需要加密的资产字段 key 集合。
// 业务约定：assets.fields JSONB 里这几个 key 是 SSH 类凭据，全部走加密通道。
// 中间件配置等其他敏感字段（密码、密钥）目前不在本平台 schema 内，由中间件表自行处理。
var secretFieldKeys = map[string]bool{
	"普通用户密码":    true,
	"超级管理员用户密码": true,
	"密码":        true,
}

// encryptAssetFields 就地加密 inputs 里的秘密字段（保护原 map，由 caller 决定是否覆盖）。
func encryptAssetFields(inputs map[string]interface{}) error {
	if inputs == nil {
		return nil
	}
	for k, v := range inputs {
		if !secretFieldKeys[k] {
			continue
		}
		s, ok := v.(string)
		if !ok {
			continue
		}
		enc, err := encryptField(s)
		if err != nil {
			return fmt.Errorf("字段 %s 加密失败: %w", k, err)
		}
		inputs[k] = enc
	}
	return nil
}

// decryptAssetFields 就地解密 outputs 里的秘密字段。失败返回错误并保持原文（不丢数据）。
func decryptAssetFields(outputs map[string]interface{}) error {
	if outputs == nil {
		return nil
	}
	for k, v := range outputs {
		if !secretFieldKeys[k] {
			continue
		}
		s, ok := v.(string)
		if !ok {
			continue
		}
		dec, err := decryptField(s)
		if err != nil {
			return fmt.Errorf("字段 %s 解密失败: %w", k, err)
		}
		outputs[k] = dec
	}
	return nil
}
