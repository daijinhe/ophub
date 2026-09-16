package main

import (
	"log"
	"time"
)

// StartScheduler 启动巡检定时调度器（每分钟检查到期任务）
func StartScheduler() {
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		// 启动后先补跑一次到期任务
		runDueTasks()
		for range ticker.C {
			runDueTasks()
		}
	}()
	log.Println("巡检定时调度器已启动")
}

// runDueTasks 执行所有到点的启用任务
func runDueTasks() {
	var tasks []InspectionTask
	now := time.Now()
	if err := DB.Where("schedule_enabled = ? AND freq <> ? AND status <> ? AND next_run_at IS NOT NULL AND next_run_at <= ?",
		true, FreqManual, "running", now).Find(&tasks).Error; err != nil {
		return
	}
	for _, t := range tasks {
		t.Status = "running"
		DB.Save(&t)
		go func(task InspectionTask) {
			_, _ = executeInspection(&task)
			next := computeNextRun(task.Freq, time.Now())
			task.NextRunAt = next
			DB.Save(&task)
		}(t)
	}
}
