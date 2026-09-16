package main

import (
	"strconv"

	"github.com/gin-gonic/gin"
)

// StatsOverview 概览统计：资源总数 + 近 14 天资产增长趋势
// GET /api/stats/overview
func StatsOverview(c *gin.Context) {
	var users, roles, assets, categories int64
	DB.Model(&User{}).Count(&users)
	DB.Model(&Role{}).Count(&roles)
	DB.Model(&Category{}).Count(&categories)
	DB.Model(&Asset{}).Count(&assets)

	type trendRow struct {
		Date  string `gorm:"column:date"`
		Count int    `gorm:"column:count"`
	}
	// 用 make 初始化：GORM Scan 在 0 行时若底层是 nil slice，JSON 会序列化为 null，
	// 前端 `trend.length` 直接崩；make 后即便是空数组也会序列化为 `[]`。
	trend := make([]trendRow, 0)
	DB.Model(&Asset{}).
		Select("TO_CHAR(created_at, 'MM-DD') AS date, COUNT(*) AS count").
		Where("created_at >= NOW() - INTERVAL '13 days'").
		Group("date").Order("date").Scan(&trend)

	OK(c, gin.H{
		"total": gin.H{
			"users":      users,
			"roles":      roles,
			"categories": categories,
			"assets":     assets,
		},
		"trend": trend,
	})
}

// StatsGroup 对任意模板字段做分布聚合（可拓展分析维度）
// GET /api/stats/group?field=<字段key>&limit=<n>
func StatsGroup(c *gin.Context) {
	key := c.Query("field")
	limit, _ := strconv.Atoi(c.Query("limit"))
	if limit <= 0 {
		limit = 10
	}
	if limit > 50 {
		limit = 50
	}

	// 仅允许模板内置字段，避免 SQL 注入
	valid := false
	for _, f := range FieldDefs {
		if f.Key == key {
			valid = true
			break
		}
	}
	if !valid || key == "" {
		Fail(c, 400, 400, "无效的统计字段")
		return
	}

	type kv struct {
		Value string `gorm:"column:v"`
		Count int    `gorm:"column:c"`
	}
	var rows []kv
	col := "fields->>'" + key + "'"
	DB.Model(&Asset{}).
		Select(col + " AS v, COUNT(*) AS c").
		Where(col + " <> '' AND " + col + " IS NOT NULL").
		Group("v").Order("c DESC").Limit(limit).Scan(&rows)

	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, gin.H{"value": r.Value, "count": r.Count})
	}
	OK(c, out)
}
