-- ================================================================
-- 运营后台数据库初始化脚本
-- 运行方式（MySQL 命令行）：source /path/to/init.sql
-- 或：mysql -u root -p < init.sql
-- ================================================================

-- 创建数据库（如果不存在）
CREATE DATABASE IF NOT EXISTS prompt_tool_admin
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE prompt_tool_admin;

-- -------------------------------------------------------
-- 用户表
-- 账号长度 ≤ 15 位，不允许重复
-- 姓名长度 ≤ 20 位（可选，超管可修改）
-- 密码 MD5 加密存储，长度 ≥ 6 位（业务层校验）
-- is_deleted = 1 表示软删除
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username     VARCHAR(15) NOT NULL COMMENT '账号，最大15位',
  name         VARCHAR(20)          COMMENT '姓名，最大20位',
  password     VARCHAR(32) NOT NULL COMMENT 'MD5加密后的密码',
  is_admin     TINYINT(1)  NOT NULL DEFAULT 0 COMMENT '1=管理员，0=普通用户',
  is_deleted   TINYINT(1)  NOT NULL DEFAULT 0 COMMENT '1=已删除，0=正常',
  created_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户表';

-- 已有数据库升级：添加姓名字段（如不存在则跳过）
ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(20) COMMENT '姓名，最大20位';

-- -------------------------------------------------------
-- Session 表（express-session + connect-mysql）
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  expires     INT UNSIGNED NOT NULL,
  data        MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Session存储';

-- -------------------------------------------------------
-- 初始化管理员账号
-- 用户名：admin
-- 密码：admin123（MD5: 0192023a7bbd73250516f069df18b500）
-- -------------------------------------------------------
INSERT INTO users (username, password, is_admin)
VALUES ('admin', '0192023a7bbd73250516f069df18b500', 1)
ON DUPLICATE KEY UPDATE password = VALUES(password), is_admin = 1;
