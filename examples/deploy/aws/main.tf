terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "instance_type" {
  type    = string
  default = "m7g.xlarge"
}

variable "repo" {
  type = string
}

variable "ref" {
  type    = string
  default = "main"
}

variable "dir" {
  type    = string
  default = "."
}

provider "aws" {
  region = var.region
}

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

resource "aws_iam_role" "agentgraph" {
  name = "agentgraph"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ec2.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.agentgraph.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "agentgraph" {
  name = "agentgraph"
  role = aws_iam_role.agentgraph.name
}

resource "aws_security_group" "agentgraph" {
  name = "agentgraph"
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "agentgraph" {
  ami                    = data.aws_ssm_parameter.ubuntu.value
  instance_type          = var.instance_type
  iam_instance_profile   = aws_iam_instance_profile.agentgraph.name
  vpc_security_group_ids = [aws_security_group.agentgraph.id]
  user_data = templatefile("${path.module}/user-data.sh", { repo = var.repo, ref = var.ref, dir = var.dir })
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_size = 100
    volume_type = "gp3"
    encrypted   = true
  }
  tags = { Name = "agentgraph" }
}

output "connect" {
  value = "aws ssm start-session --region ${var.region} --target ${aws_instance.agentgraph.id}"
}
