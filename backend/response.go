package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"gorm.io/datatypes"
)

// Resp 统一返回结构
type Resp struct {
	Code int         `json:"code"`
	Msg  string      `json:"msg"`
	Data interface{} `json:"data"`
}

// OK 成功返回
func OK(c *gin.Context, data interface{}) {
	c.JSON(http.StatusOK, Resp{Code: 0, Msg: "ok", Data: data})
}

// Fail 失败返回
func Fail(c *gin.Context, httpStatus, code int, msg string) {
	c.JSON(httpStatus, Resp{Code: code, Msg: msg})
}

// PageOK 分页返回
func PageOK(c *gin.Context, list interface{}, total int64, page, pageSize int) {
	OK(c, gin.H{"list": list, "total": total, "page": page, "pageSize": pageSize})
}

// toJSON 将任意结构转为 datatypes.JSON（JSONB）
func toJSON(v interface{}) datatypes.JSON {
	b, _ := json.Marshal(v)
	return datatypes.JSON(b)
}

// toStr 将任意值转为字符串（模板占位替换用）
func toStr(v interface{}) string {
	switch t := v.(type) {
	case string:
		return t
	case nil:
		return ""
	case float64:
		// JSON 数字去尾零
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}
