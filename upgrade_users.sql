USE prompt_tool_admin;

-- 检查并添加姓名字段（MySQL 5.7兼容写法）
SET @dbname = DATABASE();
SET @tablename = 'users';
SET @columnname = 'name';
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname
  ) > 0,
  'SELECT 1',
  'ALTER TABLE users ADD COLUMN name VARCHAR(20) COMMENT ''姓名，最大20位'''
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- 修改username字段长度
ALTER TABLE users MODIFY COLUMN username VARCHAR(15) NOT NULL COMMENT '账号，最大15位';

-- 查看结果
DESCRIBE users;
